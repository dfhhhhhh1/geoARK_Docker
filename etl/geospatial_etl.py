#!/usr/bin/env python3
"""
Production-Ready Geospatial Data Ingestion Pipeline
====================================================

This script recursively scans directories and imports geospatial data into PostGIS:
- ESRI Shapefiles
- ESRI File Geodatabases (.gdb)
- Large CSV files

Features:
- Automatic metadata extraction and storage
- Idempotent (can be re-run safely)
- Progress tracking and error handling
- Unzips compressed files automatically
- Skips already-imported datasets

Requirements:
    pip install psycopg2-binary pandas sqlalchemy geoalchemy2 gdal

Author: Geospatial ETL System
Date: 2025
"""

import os
import sys
import zipfile
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple
import json
import urllib.parse

import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_values
import pandas as pd
from sqlalchemy import create_engine
from osgeo import gdal, ogr, osr

# Enable GDAL exceptions
gdal.UseExceptions()
ogr.UseExceptions()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('geospatial_etl.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


class GeospatialETL:
    """
    Main ETL class for importing geospatial data into PostGIS.
    """
    
    def __init__(self, db_config: Dict[str, str], root_directory: str):
        """
        Initialize the ETL pipeline.
        
        Args:
            db_config: Database connection parameters
            root_directory: Root directory to scan for data
        """
        self.db_config = db_config
        self.root_directory = Path(root_directory)
        self.conn = None
        self.cursor = None
        self.engine = None
        
        # Statistics
        self.stats = {
            'imported': 0,
            'skipped': 0,
            'errors': 0,
            'unzipped': 0
        }
        
    def connect(self):
        """Establish database connection."""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            self.conn.autocommit = False
            self.cursor = self.conn.cursor()
            logger.info("Database connection established")
            
            # Create SQLAlchemy engine for pandas
            connection_string = (
                f"postgresql://{self.db_config['user']}:{self.db_config['password']}"
                f"@{self.db_config['host']}:{self.db_config['port']}/{self.db_config['database']}"
            )
            self.engine = create_engine(connection_string)
            
            # Enable PostGIS if not already enabled
            self.cursor.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
            self.conn.commit()
            
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            raise
    
    def disconnect(self):
        """Close database connection."""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        if self.engine:
            self.engine.dispose()
        logger.info("Database connection closed")
    
    def create_metadata_table(self):
        """Create metadata table if it doesn't exist."""
        create_table_sql = """
        CREATE TABLE IF NOT EXISTS dataset_metadata (
            id SERIAL PRIMARY KEY,
            dataset_name TEXT NOT NULL,
            table_name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            geometry_type TEXT,
            row_count INTEGER,
            column_list TEXT[],
            crs TEXT,
            bbox TEXT,
            date_ingested TIMESTAMP DEFAULT now(),
            UNIQUE(table_name)
        );
        
        CREATE INDEX IF NOT EXISTS idx_metadata_table_name 
        ON dataset_metadata(table_name);
        
        CREATE INDEX IF NOT EXISTS idx_metadata_source_path 
        ON dataset_metadata(source_path);
        """
        
        try:
            self.cursor.execute(create_table_sql)
            self.conn.commit()
            logger.info("Metadata table created/verified")
        except Exception as e:
            self.conn.rollback()
            logger.error(f"Failed to create metadata table: {e}")
            raise
    
    def table_exists(self, table_name: str) -> bool:
        """
        Check if a table already exists in the database.
        
        Args:
            table_name: Name of the table to check
            
        Returns:
            True if table exists, False otherwise
        """
        check_sql = """
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = %s
        );
        """
        
        self.cursor.execute(check_sql, (table_name,))
        return self.cursor.fetchone()[0]
    
    def sanitize_table_name(self, name: str) -> str:
        """
        Sanitize a filename to create a valid PostgreSQL table name.
        
        Args:
            name: Original filename or path
            
        Returns:
            Sanitized table name
        """
        # Remove extension and special characters
        name = Path(name).stem.lower()
        name = ''.join(c if c.isalnum() or c == '_' else '_' for c in name)
        
        # Ensure it starts with a letter or underscore
        if name and name[0].isdigit():
            name = f"table_{name}"
        
        # Truncate to PostgreSQL limit (63 characters)
        return name[:63]
    
    def unzip_file(self, zip_path: Path, extract_to: Path) -> bool:
        """
        Unzip a file if the extracted content doesn't already exist.
        
        Args:
            zip_path: Path to zip file
            extract_to: Directory to extract to
            
        Returns:
            True if unzipped, False if already extracted
        """
        try:
            # Check if already extracted by looking for common files
            if extract_to.exists() and any(extract_to.iterdir()):
                logger.info(f"Skipping unzip - already extracted: {zip_path.name}")
                return False
            
            extract_to.mkdir(parents=True, exist_ok=True)
            
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_to)
            
            logger.info(f"Unzipped: {zip_path.name}")
            self.stats['unzipped'] += 1
            return True
            
        except Exception as e:
            logger.error(f"Failed to unzip {zip_path}: {e}")
            return False
    
    def get_geometry_info(self, layer: ogr.Layer) -> Tuple[str, str]:
        """
        Extract geometry type and CRS from OGR layer.
        
        Args:
            layer: OGR Layer object
            
        Returns:
            Tuple of (geometry_type, crs_string)
        """
        geom_type = ogr.GeometryTypeToName(layer.GetGeomType())
        
        spatial_ref = layer.GetSpatialRef()
        if spatial_ref:
            spatial_ref.AutoIdentifyEPSG()
            epsg_code = spatial_ref.GetAuthorityCode(None)
            crs = f"EPSG:{epsg_code}" if epsg_code else spatial_ref.ExportToWkt()
        else:
            crs = "Unknown"
        
        return geom_type, crs
    
    def get_bbox_from_table(self, table_name: str, geom_column: str = 'geom') -> Optional[str]:
        """
        Calculate bounding box from PostGIS table.
        
        Args:
            table_name: Name of the table
            geom_column: Name of geometry column
            
        Returns:
            Bounding box as string or None
        """
        try:
            # First, find the actual geometry column name
            find_geom_sql = """
                SELECT f_geometry_column 
                FROM geometry_columns 
                WHERE f_table_name = %s
                LIMIT 1;
            """
            self.cursor.execute(find_geom_sql, (table_name,))
            result = self.cursor.fetchone()
            
            if result:
                actual_geom_col = result[0]
            else:
                # Fallback to provided column name
                actual_geom_col = geom_column
            
            bbox_sql = sql.SQL("""
                SELECT ST_AsText(ST_Extent({geom_col})) 
                FROM {table}
            """).format(
                geom_col=sql.Identifier(actual_geom_col),
                table=sql.Identifier(table_name)
            )
            
            self.cursor.execute(bbox_sql)
            result = self.cursor.fetchone()
            return result[0] if result and result[0] else None
            
        except Exception as e:
            logger.warning(f"Could not calculate bbox for {table_name}: {e}")
            # Rollback the failed transaction
            self.conn.rollback()
            return None
    
    def get_table_columns(self, table_name: str) -> List[str]:
        """
        Get list of columns from a table.
        
        Args:
            table_name: Name of the table
            
        Returns:
            List of column names
        """
        try:
            columns_sql = """
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = %s
            ORDER BY ordinal_position;
            """
            
            self.cursor.execute(columns_sql, (table_name,))
            return [row[0] for row in self.cursor.fetchall()]
        except Exception as e:
            logger.warning(f"Could not get columns for {table_name}: {e}")
            self.conn.rollback()
            return []
    
    def get_row_count(self, table_name: str) -> int:
        """
        Get number of rows in a table.
        
        Args:
            table_name: Name of the table
            
        Returns:
            Number of rows
        """
        try:
            count_sql = sql.SQL("SELECT COUNT(*) FROM {table}").format(
                table=sql.Identifier(table_name)
            )
            
            self.cursor.execute(count_sql)
            return self.cursor.fetchone()[0]
        except Exception as e:
            logger.warning(f"Could not get row count for {table_name}: {e}")
            self.conn.rollback()
            return 0
    
    def insert_metadata(self, metadata: Dict):
        """
        Insert or update metadata for a dataset.
        
        Args:
            metadata: Dictionary containing metadata fields
        """
        insert_sql = """
        INSERT INTO dataset_metadata 
            (dataset_name, table_name, source_path, geometry_type, 
             row_count, column_list, crs, bbox)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (table_name) 
        DO UPDATE SET
            dataset_name = EXCLUDED.dataset_name,
            source_path = EXCLUDED.source_path,
            geometry_type = EXCLUDED.geometry_type,
            row_count = EXCLUDED.row_count,
            column_list = EXCLUDED.column_list,
            crs = EXCLUDED.crs,
            bbox = EXCLUDED.bbox,
            date_ingested = now();
        """
        
        try:
            self.cursor.execute(insert_sql, (
                metadata['dataset_name'],
                metadata['table_name'],
                metadata['source_path'],
                metadata.get('geometry_type'),
                metadata.get('row_count'),
                metadata.get('column_list'),
                metadata.get('crs'),
                metadata.get('bbox')
            ))
            self.conn.commit()
            
        except Exception as e:
            self.conn.rollback()
            logger.error(f"Failed to insert metadata for {metadata['table_name']}: {e}")
            raise
    
    def import_shapefile(self, shp_path: Path):
        """
        Import ESRI Shapefile into PostGIS using ogr2ogr.
        
        Args:
            shp_path: Path to .shp file
        """
        table_name = self.sanitize_table_name(shp_path.stem)
        
        # Check if already imported
        if self.table_exists(table_name):
            logger.info(f"Skipping existing table: {table_name}")
            self.stats['skipped'] += 1
            return
        
        logger.info(f"Importing shapefile: {shp_path.name} -> {table_name}")
        
        try:
            # Open shapefile to extract metadata
            data_source = ogr.Open(str(shp_path))
            if not data_source:
                raise Exception(f"Could not open shapefile: {shp_path}")
            
            layer = data_source.GetLayer()
            geom_type, crs = self.get_geometry_info(layer)
            feature_count = layer.GetFeatureCount()
            
            # Get field names
            layer_defn = layer.GetLayerDefn()
            field_names = [layer_defn.GetFieldDefn(i).GetName() 
                          for i in range(layer_defn.GetFieldCount())]
            
            data_source = None  # Close
            
            # Build ogr2ogr connection string
            # For empty password, omit the password parameter entirely
            if self.db_config.get('password'):
                password_encoded = urllib.parse.quote(self.db_config['password'], safe='')
                pg_connection = (
                    f"PG:host={self.db_config['host']} "
                    f"port={self.db_config['port']} "
                    f"dbname={self.db_config['database']} "
                    f"user={self.db_config['user']} "
                    f"password={password_encoded}"
                )
            else:
                # No password - omit password parameter
                pg_connection = (
                    f"PG:host={self.db_config['host']} "
                    f"port={self.db_config['port']} "
                    f"dbname={self.db_config['database']} "
                    f"user={self.db_config['user']}"
                )
            
            # Import using ogr2ogr via GDAL Python API
            options = gdal.VectorTranslateOptions(
                format='PostgreSQL',
                dstSRS='EPSG:4326',  # Reproject to WGS84
                layerName=table_name,
                skipFailures=True,
                layerCreationOptions=['GEOMETRY_NAME=geom', 'OVERWRITE=YES'],
                options=['-nlt', 'PROMOTE_TO_MULTI']  # Promote all geometries to MULTI type
            )
            
            result = gdal.VectorTranslate(
                pg_connection,
                str(shp_path),
                options=options
            )
            
            if result is None:
                raise Exception("ogr2ogr failed to import shapefile")
            
            result = None  # Close
            
            # Calculate bbox from imported table (try both column names)
            bbox = self.get_bbox_from_table(table_name)
            
            # Get actual row count from imported table
            row_count = self.get_row_count(table_name)
            
            # Get actual columns from imported table
            columns = self.get_table_columns(table_name)
            
            # Store metadata
            metadata = {
                'dataset_name': shp_path.stem,
                'table_name': table_name,
                'source_path': str(shp_path),
                'geometry_type': geom_type,
                'row_count': row_count,
                'column_list': columns,
                'crs': crs,
                'bbox': bbox
            }
            
            self.insert_metadata(metadata)
            
            self.stats['imported'] += 1
            logger.info(f"Successfully imported: {table_name} ({row_count} rows)")
            
        except Exception as e:
            self.stats['errors'] += 1
            logger.error(f"Failed to import shapefile {shp_path}: {e}")
    
    def import_filegdb(self, gdb_path: Path):
        """
        Import ESRI File Geodatabase into PostGIS.
        
        Args:
            gdb_path: Path to .gdb directory
        """
        logger.info(f"Processing FileGDB: {gdb_path.name}")
        
        try:
            # Open FileGDB
            data_source = ogr.Open(str(gdb_path))
            if not data_source:
                raise Exception(f"Could not open FileGDB: {gdb_path}")
            
            layer_count = data_source.GetLayerCount()
            logger.info(f"Found {layer_count} layers in {gdb_path.name}")
            
            # Import each layer
            for i in range(layer_count):
                layer = data_source.GetLayer(i)
                layer_name = layer.GetName()
                table_name = self.sanitize_table_name(f"{gdb_path.stem}_{layer_name}")
                
                # Check if already imported
                if self.table_exists(table_name):
                    logger.info(f"Skipping existing table: {table_name}")
                    self.stats['skipped'] += 1
                    continue
                
                logger.info(f"Importing layer: {layer_name} -> {table_name}")
                
                try:
                    geom_type, crs = self.get_geometry_info(layer)
                    feature_count = layer.GetFeatureCount()
                    
                    # Get field names
                    layer_defn = layer.GetLayerDefn()
                    field_names = [layer_defn.GetFieldDefn(j).GetName() 
                                  for j in range(layer_defn.GetFieldCount())]
                    
                    # Build ogr2ogr connection string
                    # For empty password, omit the password parameter entirely
                    if self.db_config.get('password'):
                        password_encoded = urllib.parse.quote(self.db_config['password'], safe='')
                        pg_connection = (
                            f"PG:host={self.db_config['host']} "
                            f"port={self.db_config['port']} "
                            f"dbname={self.db_config['database']} "
                            f"user={self.db_config['user']} "
                            f"password={password_encoded}"
                        )
                    else:
                        # No password - omit password parameter
                        pg_connection = (
                            f"PG:host={self.db_config['host']} "
                            f"port={self.db_config['port']} "
                            f"dbname={self.db_config['database']} "
                            f"user={self.db_config['user']}"
                        )
                    
                    # Import using ogr2ogr via GDAL Python API
                    options = gdal.VectorTranslateOptions(
                        format='PostgreSQL',
                        dstSRS='EPSG:4326',
                        layerName=table_name,
                        skipFailures=True,
                        layers=[layer_name],
                        layerCreationOptions=['GEOMETRY_NAME=geom', 'OVERWRITE=YES'],
                        options=['-nlt', 'PROMOTE_TO_MULTI']  # Promote all geometries to MULTI type
                    )
                    
                    result = gdal.VectorTranslate(
                        pg_connection,
                        str(gdb_path),
                        options=options
                    )
                    
                    if result is None:
                        raise Exception(f"Failed to import layer {layer_name}")
                    
                    result = None  # Close
                    
                    # Calculate bbox
                    bbox = self.get_bbox_from_table(table_name, 'wkb_geometry')
                    
                    # Get actual row count and columns
                    row_count = self.get_row_count(table_name)
                    columns = self.get_table_columns(table_name)
                    
                    # Store metadata
                    metadata = {
                        'dataset_name': f"{gdb_path.stem}_{layer_name}",
                        'table_name': table_name,
                        'source_path': str(gdb_path / layer_name),
                        'geometry_type': geom_type,
                        'row_count': row_count,
                        'column_list': columns,
                        'crs': crs,
                        'bbox': bbox
                    }
                    
                    self.insert_metadata(metadata)
                    
                    self.stats['imported'] += 1
                    logger.info(f"Successfully imported: {table_name} ({row_count} rows)")
                    
                except Exception as e:
                    self.stats['errors'] += 1
                    logger.error(f"Failed to import layer {layer_name}: {e}")
            
            data_source = None  # Close
            
        except Exception as e:
            self.stats['errors'] += 1
            logger.error(f"Failed to process FileGDB {gdb_path}: {e}")
    
    def import_csv(self, csv_path: Path):
        """
        Import large CSV file into PostgreSQL.
        
        Args:
            csv_path: Path to CSV file
        """
        table_name = self.sanitize_table_name(csv_path.stem)
        
        # Check if already imported
        if self.table_exists(table_name):
            logger.info(f"Skipping existing table: {table_name}")
            self.stats['skipped'] += 1
            return
        
        logger.info(f"Importing CSV: {csv_path.name} -> {table_name}")
        
        try:
            # Read CSV in chunks for memory efficiency
            chunk_size = 10000
            first_chunk = True
            total_rows = 0
            
            for chunk in pd.read_csv(csv_path, chunksize=chunk_size, low_memory=False):
                # Normalize FIPS codes if present
                fips_columns = [col for col in chunk.columns 
                              if 'fips' in col.lower() or 'geoid' in col.lower()]
                
                for fips_col in fips_columns:
                    if chunk[fips_col].dtype == 'object':
                        chunk[fips_col] = chunk[fips_col].astype(str).str.zfill(5)
                
                # Write to database using SQLAlchemy engine
                if first_chunk:
                    chunk.to_sql(
                        table_name,
                        self.engine,
                        if_exists='replace',
                        index=False,
                        method='multi',
                        chunksize=1000
                    )
                    first_chunk = False
                else:
                    chunk.to_sql(
                        table_name,
                        self.engine,
                        if_exists='append',
                        index=False,
                        method='multi',
                        chunksize=1000
                    )
                
                total_rows += len(chunk)
                logger.info(f"Imported {total_rows} rows...")
            
            # Get columns
            columns = self.get_table_columns(table_name)
            
            # Store metadata
            metadata = {
                'dataset_name': csv_path.stem,
                'table_name': table_name,
                'source_path': str(csv_path),
                'geometry_type': None,
                'row_count': total_rows,
                'column_list': columns,
                'crs': None,
                'bbox': None
            }
            
            self.insert_metadata(metadata)
            
            self.stats['imported'] += 1
            logger.info(f"Successfully imported CSV: {table_name} ({total_rows} rows, {len(columns)} columns)")
            
        except Exception as e:
            self.stats['errors'] += 1
            logger.error(f"Failed to import CSV {csv_path}: {e}")
    
    def scan_and_import(self):
        """
        Recursively scan directory and import all datasets.
        """
        logger.info(f"Scanning directory: {self.root_directory}")
        
        # Track processed zips to avoid duplicate extraction
        processed_zips = set()
        
        # First pass: handle zip files
        for zip_file in self.root_directory.rglob("*.zip"):
            if zip_file in processed_zips:
                continue
            
            extract_dir = zip_file.parent / zip_file.stem
            self.unzip_file(zip_file, extract_dir)
            processed_zips.add(zip_file)
        
        # Second pass: import shapefiles
        for shp_file in self.root_directory.rglob("*.shp"):
            self.import_shapefile(shp_file)
        
        # Third pass: import FileGDBs
        for gdb_dir in self.root_directory.rglob("*.gdb"):
            if gdb_dir.is_dir():
                self.import_filegdb(gdb_dir)
        
        # Fourth pass: import CSVs
        for csv_file in self.root_directory.rglob("*.csv"):
            self.import_csv(csv_file)
    
    def run(self):
        """
        Execute the complete ETL pipeline.
        """
        try:
            logger.info("=" * 60)
            logger.info("Starting Geospatial ETL Pipeline")
            logger.info("=" * 60)
            
            self.connect()
            self.create_metadata_table()
            self.scan_and_import()
            
            logger.info("=" * 60)
            logger.info("ETL Pipeline Complete")
            logger.info(f"Ingestion complete. "
                       f"{self.stats['imported']} layers imported, "
                       f"{self.stats['skipped']} skipped, "
                       f"{self.stats['errors']} errors.")
            logger.info(f"Files unzipped: {self.stats['unzipped']}")
            logger.info("=" * 60)
            
        except Exception as e:
            logger.error(f"ETL pipeline failed: {e}")
            raise
        
        finally:
            self.disconnect()


def main():
    """
    Main entry point for the ETL pipeline.
    """
    # Environment-driven, so this runs in the compose `etl` job against the
    # `db` service instead of a hardcoded localhost with a literal password.
    DB_CONFIG = {
        'host': os.environ.get('PGHOST', 'localhost'),
        'port': os.environ.get('PGPORT', '5432'),
        'database': os.environ.get('PGDATABASE', 'mygisdb'),
        'user': os.environ.get('PGUSER', 'geoark'),
        'password': os.environ.get('PGPASSWORD', ''),
    }

    ROOT_DIRECTORY = os.environ.get('GEODATA_ROOT', './')
    
    # Validate configuration
    if not Path(ROOT_DIRECTORY).exists():
        logger.error(f"Directory does not exist: {ROOT_DIRECTORY}")
        sys.exit(1)
    
    # Create and run ETL pipeline
    etl = GeospatialETL(DB_CONFIG, ROOT_DIRECTORY)
    etl.run()


if __name__ == "__main__":
    main()
