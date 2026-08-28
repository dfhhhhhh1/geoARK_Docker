import { useState, useMemo, useEffect, useRef } from 'react';
import Papa from 'papaparse';
import * as d3 from 'd3';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import { Upload, AlertCircle, TrendingUp, BarChart3 } from 'lucide-react';
import _ from 'lodash';

interface ParsedData {
  headers: string[];
  rows: Record<string, string | number>[];
}

interface ColumnStats {
  column: string;
  count: number;
  missing: number;
  sum: number;
  avg: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  p25: number;
  
  p75: number;
}

interface CategoricalStats {
  column: string;
  uniqueCount: number;
  topValues: Array<{ value: string; count: number }>;
  missing: number;
}

function ReportPage() {
  const [csvData, setCsvData] = useState<ParsedData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [error, setError] = useState<string>('');
  
  // Column selections
  const [labelColumn, setLabelColumn] = useState<string>('');
  const [selectedNumericColumns, setSelectedNumericColumns] = useState<string[]>([]);
  const [selectedCategoricalColumns, setSelectedCategoricalColumns] = useState<string[]>([]);

  // Refs for D3 charts
  const lineChartRef = useRef<HTMLDivElement>(null);
  const barChartRef = useRef<HTMLDivElement>(null);
  const pieChartRef = useRef<HTMLDivElement>(null);
  const categoricalChartRef = useRef<HTMLDivElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.csv')) {
      setError('Please upload a valid CSV file');
      event.target.value = '';
      return;
    }

    setError('');
    setFileName(file.name);
    setIsLoading(true);

    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.data && results.data.length > 0) {
          const headers = (results.meta.fields || []).map(h => h.trim());
          const rows = results.data.filter(
            (row) => Object.values(row).some((val) => val !== null && val !== '')
          ) as Record<string, string | number>[];

          setCsvData({
            headers,
            rows,
          });

          // Auto-select first column as label
          if (headers.length > 0) {
            setLabelColumn(headers[0]);
          }

          // Auto-select first 2 numeric columns
          const numericCols = headers.filter((h) => 
            rows.length > 0 && typeof rows[0][h] === 'number'
          );
          setSelectedNumericColumns(numericCols.slice(0, 2));

          // Auto-select first categorical column
          const categoricalCols = headers.filter((h) => 
            rows.length > 0 && typeof rows[0][h] === 'string'
          );
          setSelectedCategoricalColumns(categoricalCols.slice(0, 1));

          setTimeout(() => {
            setIsLoading(false);
          }, 500);
        } else {
          setError('CSV file is empty or invalid');
          setIsLoading(false);
        }

        event.target.value = '';
      },
      error: (parseError) => {
        setError(`Error parsing CSV: ${parseError.message}`);
        setIsLoading(false);
        event.target.value = '';
      },
    });
  };

  // Identify column types
  const columnTypes = useMemo(() => {
    if (!csvData || csvData.rows.length === 0) return { numeric: [], categorical: [] };

    const numeric: string[] = [];
    const categorical: string[] = [];

    csvData.headers.forEach(header => {
      const sampleValue = csvData.rows[0][header];
      if (typeof sampleValue === 'number') {
        numeric.push(header);
      } else {
        categorical.push(header);
      }
    });

    return { numeric, categorical };
  }, [csvData]);

  // Calculate statistics for numeric columns
  const calculateStats = (column: string): ColumnStats | null => {
    if (!csvData) return null;

    const values = csvData.rows
      .map(row => row[column])
      .filter(val => val !== null && val !== undefined && val !== '');
    
    const numericValues = values
      .map(val => Number(val))
      .filter(val => !isNaN(val));

    if (numericValues.length === 0) return null;

    const sorted = [...numericValues].sort((a, b) => a - b);
    const sum = numericValues.reduce((acc, val) => acc + val, 0);
    const avg = sum / numericValues.length;
    
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    
    const variance = numericValues.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / numericValues.length;
    const stdDev = Math.sqrt(variance);
    
    const p25Index = Math.floor(sorted.length * 0.25);
    const p75Index = Math.floor(sorted.length * 0.75);

    return {
      column,
      count: numericValues.length,
      missing: csvData.rows.length - values.length,
      sum,
      avg,
      median,
      stdDev,
      min: Math.min(...numericValues),
      max: Math.max(...numericValues),
      p25: sorted[p25Index],
      p75: sorted[p75Index],
    };
  };

  // Calculate categorical statistics
  const calculateCategoricalStats = (column: string): CategoricalStats | null => {
    if (!csvData) return null;

    const values = csvData.rows
      .map(row => row[column])
      .filter(val => val !== null && val !== undefined && val !== '');

    const grouped = _.groupBy(values, v => String(v));
    const counts = Object.entries(grouped).map(([value, items]) => ({
      value,
      count: items.length,
    }));
    
    const topValues = _.orderBy(counts, 'count', 'desc').slice(0, 10);

    return {
      column,
      uniqueCount: Object.keys(grouped).length,
      topValues,
      missing: csvData.rows.length - values.length,
    };
  };

  // Calculate correlation between two numeric columns
  const calculateCorrelation = (col1: string, col2: string): number | null => {
    if (!csvData) return null;

    const pairs = csvData.rows
      .map(row => [Number(row[col1]), Number(row[col2])])
      .filter(([a, b]) => !isNaN(a) && !isNaN(b));

    if (pairs.length < 2) return null;

    const mean1 = pairs.reduce((sum, [a]) => sum + a, 0) / pairs.length;
    const mean2 = pairs.reduce((sum, [, b]) => sum + b, 0) / pairs.length;

    let numerator = 0;
    let sum1 = 0;
    let sum2 = 0;

    pairs.forEach(([a, b]) => {
      const diff1 = a - mean1;
      const diff2 = b - mean2;
      numerator += diff1 * diff2;
      sum1 += diff1 * diff1;
      sum2 += diff2 * diff2;
    });

    const denominator = Math.sqrt(sum1 * sum2);
    return denominator === 0 ? 0 : numerator / denominator;
  };

  // D3 Line Chart
  useEffect(() => {
    if (!csvData || !labelColumn || selectedNumericColumns.length === 0 || !lineChartRef.current) return;

    const container = lineChartRef.current;
    d3.select(container).selectAll('*').remove();

    const margin = { top: 20, right: 120, bottom: 60, left: 60 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 400 - margin.top - margin.bottom;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const data = csvData.rows.map((row, i) => ({
      label: String(row[labelColumn] || i),
      ...selectedNumericColumns.reduce((acc, col) => ({
        ...acc,
        [col]: Number(row[col]) || 0
      }), {})
    }));

    // X scale
    const x = d3.scaleLinear()
      .domain([0, data.length - 1])
      .range([0, width]);

    // Y scale
    const allValues = selectedNumericColumns.flatMap(col => 
      data.map(d => d[col] as number)
    );
    const y = d3.scaleLinear()
      .domain([d3.min(allValues) || 0, d3.max(allValues) || 0])
      .nice()
      .range([height, 0]);

    // Color scale
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

    // Add X axis
    svg.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(Math.min(10, data.length)))
      .selectAll('text')
      .attr('transform', 'rotate(-45)')
      .style('text-anchor', 'end');

    // Add Y axis
    svg.append('g')
      .call(d3.axisLeft(y));

    // Add lines
    selectedNumericColumns.forEach((col, idx) => {
      const line = d3.line<any>()
        .x((d, i) => x(i))
        .y(d => y(d[col]))
        .curve(d3.curveMonotoneX);

      svg.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', colors[idx % colors.length])
        .attr('stroke-width', 2)
        .attr('d', line);

      // Add dots
      svg.selectAll(`.dot-${idx}`)
        .data(data)
        .enter()
        .append('circle')
        .attr('class', `dot-${idx}`)
        .attr('cx', (d, i) => x(i))
        .attr('cy', d => y(d[col] as number))
        .attr('r', 3)
        .attr('fill', colors[idx % colors.length]);
    });

    // Add legend
    const legend = svg.selectAll('.legend')
      .data(selectedNumericColumns)
      .enter()
      .append('g')
      .attr('class', 'legend')
      .attr('transform', (d, i) => `translate(${width + 10},${i * 20})`);

    legend.append('rect')
      .attr('width', 18)
      .attr('height', 18)
      .style('fill', (d, i) => colors[i % colors.length]);

    legend.append('text')
      .attr('x', 24)
      .attr('y', 9)
      .attr('dy', '.35em')
      .style('font-size', '12px')
      .text(d => d);

  }, [csvData, labelColumn, selectedNumericColumns]);

  // D3 Bar Chart
  useEffect(() => {
    if (!csvData || !labelColumn || selectedNumericColumns.length === 0 || !barChartRef.current) return;

    const container = barChartRef.current;
    d3.select(container).selectAll('*').remove();

    const margin = { top: 20, right: 120, bottom: 80, left: 60 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 400 - margin.top - margin.bottom;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Group and aggregate data
    const grouped = _.groupBy(csvData.rows, row => String(row[labelColumn] || 'Unknown'));
    const labels = Object.keys(grouped).slice(0, 15);
    
    const data = labels.map(label => ({
      label,
      ...selectedNumericColumns.reduce((acc, col) => ({
        ...acc,
        [col]: grouped[label].reduce((sum, row) => sum + (Number(row[col]) || 0), 0)
      }), {})
    }));

    // X scale
    const x0 = d3.scaleBand()
      .domain(labels)
      .rangeRound([0, width])
      .paddingInner(0.1);

    const x1 = d3.scaleBand()
      .domain(selectedNumericColumns)
      .rangeRound([0, x0.bandwidth()])
      .padding(0.05);

    // Y scale
    const allValues = data.flatMap(d => 
      selectedNumericColumns.map(col => d[col] as number)
    );
    const y = d3.scaleLinear()
      .domain([0, d3.max(allValues) || 0])
      .nice()
      .range([height, 0]);

    // Color scale
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

    // Add X axis
    svg.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x0))
      .selectAll('text')
      .attr('transform', 'rotate(-45)')
      .style('text-anchor', 'end');

    // Add Y axis
    svg.append('g')
      .call(d3.axisLeft(y));

    // Add bars
    const barGroups = svg.selectAll('.bar-group')
      .data(data)
      .enter()
      .append('g')
      .attr('class', 'bar-group')
      .attr('transform', d => `translate(${x0(d.label)},0)`);

    selectedNumericColumns.forEach((col, idx) => {
      barGroups.append('rect')
        .attr('x', x1(col) || 0)
        .attr('y', d => y(d[col] as number))
        .attr('width', x1.bandwidth())
        .attr('height', d => height - y(d[col] as number))
        .attr('fill', colors[idx % colors.length])
        .attr('opacity', 0.8);
    });

    // Add legend
    const legend = svg.selectAll('.legend')
      .data(selectedNumericColumns)
      .enter()
      .append('g')
      .attr('class', 'legend')
      .attr('transform', (d, i) => `translate(${width + 10},${i * 20})`);

    legend.append('rect')
      .attr('width', 18)
      .attr('height', 18)
      .style('fill', (d, i) => colors[i % colors.length])
      .style('opacity', 0.8);

    legend.append('text')
      .attr('x', 24)
      .attr('y', 9)
      .attr('dy', '.35em')
      .style('font-size', '12px')
      .text(d => d);

  }, [csvData, labelColumn, selectedNumericColumns]);

  // D3 Pie Chart
  useEffect(() => {
    if (!csvData || !labelColumn || selectedNumericColumns.length === 0 || !pieChartRef.current) return;

    const container = pieChartRef.current;
    d3.select(container).selectAll('*').remove();

    const width = Math.min(container.clientWidth, 500);
    const height = 400;
    const radius = Math.min(width, height) / 2 - 40;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .append('g')
      .attr('transform', `translate(${width / 2},${height / 2})`);

    const firstNumericCol = selectedNumericColumns[0];
    
    // Group and aggregate
    const grouped = _.groupBy(csvData.rows, row => String(row[labelColumn] || 'Unknown'));
    const aggregated = Object.entries(grouped).map(([label, rows]) => ({
      label,
      value: rows.reduce((sum, row) => sum + (Number(row[firstNumericCol]) || 0), 0)
    }));

    const sorted = _.orderBy(aggregated, 'value', 'desc').slice(0, 8);

    const colors = d3.scaleOrdinal()
      .domain(sorted.map(d => d.label))
      .range(['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#fb923c']);

    const pie = d3.pie<any>()
      .value(d => d.value)
      .sort(null);

    const arc = d3.arc<any>()
      .innerRadius(0)
      .outerRadius(radius);

    const labelArc = d3.arc<any>()
      .innerRadius(radius * 0.6)
      .outerRadius(radius * 0.6);

    const arcs = svg.selectAll('.arc')
      .data(pie(sorted))
      .enter()
      .append('g')
      .attr('class', 'arc');

    arcs.append('path')
      .attr('d', arc)
      .attr('fill', d => colors(d.data.label) as string)
      .attr('stroke', 'white')
      .attr('stroke-width', 2)
      .on('mouseover', function(event, d) {
        d3.select(this)
          .transition()
          .duration(200)
          .attr('transform', function() {
            const [x, y] = arc.centroid(d);
            return `translate(${x * 0.1},${y * 0.1})`;
          });
      })
      .on('mouseout', function() {
        d3.select(this)
          .transition()
          .duration(200)
          .attr('transform', 'translate(0,0)');
      });

    arcs.append('text')
      .attr('transform', d => `translate(${labelArc.centroid(d)})`)
      .attr('dy', '.35em')
      .attr('text-anchor', 'middle')
      .style('font-size', '11px')
      .style('fill', 'white')
      .style('font-weight', 'bold')
      .text(d => {
        const percentage = ((d.data.value / d3.sum(sorted, d => d.value)) * 100).toFixed(0);
        return percentage > 5 ? `${percentage}%` : '';
      });

    // Legend
    const legend = svg.selectAll('.legend')
      .data(sorted)
      .enter()
      .append('g')
      .attr('class', 'legend')
      .attr('transform', (d, i) => `translate(${radius + 20},${-radius + i * 25})`);

    legend.append('rect')
      .attr('width', 18)
      .attr('height', 18)
      .style('fill', d => colors(d.label) as string);

    legend.append('text')
      .attr('x', 24)
      .attr('y', 9)
      .attr('dy', '.35em')
      .style('font-size', '11px')
      .text(d => d.label.length > 20 ? d.label.substring(0, 20) + '...' : d.label);

  }, [csvData, labelColumn, selectedNumericColumns]);

  // D3 Categorical Chart
  useEffect(() => {
    if (!csvData || selectedCategoricalColumns.length === 0 || !categoricalChartRef.current) return;

    const container = categoricalChartRef.current;
    d3.select(container).selectAll('*').remove();

    const column = selectedCategoricalColumns[0];
    const stats = calculateCategoricalStats(column);
    
    if (!stats) return;

    const margin = { top: 20, right: 20, bottom: 80, left: 60 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 400 - margin.top - margin.bottom;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const data = stats.topValues;

    // X scale
    const x = d3.scaleBand()
      .domain(data.map(d => d.value))
      .range([0, width])
      .padding(0.2);

    // Y scale
    const y = d3.scaleLinear()
      .domain([0, d3.max(data, d => d.count) || 0])
      .nice()
      .range([height, 0]);

    // Add X axis
    svg.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x))
      .selectAll('text')
      .attr('transform', 'rotate(-45)')
      .style('text-anchor', 'end');

    // Add Y axis
    svg.append('g')
      .call(d3.axisLeft(y));

    // Add bars
    svg.selectAll('.bar')
      .data(data)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', d => x(d.value) || 0)
      .attr('y', d => y(d.count))
      .attr('width', x.bandwidth())
      .attr('height', d => height - y(d.count))
      .attr('fill', '#8b5cf6')
      .attr('opacity', 0.8);

    // Add value labels
    svg.selectAll('.label')
      .data(data)
      .enter()
      .append('text')
      .attr('class', 'label')
      .attr('x', d => (x(d.value) || 0) + x.bandwidth() / 2)
      .attr('y', d => y(d.count) - 5)
      .attr('text-anchor', 'middle')
      .style('font-size', '11px')
      .text(d => d.count);

  }, [csvData, selectedCategoricalColumns]);

  // Enhanced textual report
  const generateTextualReport = () => {
    if (!csvData || csvData.rows.length === 0) return null;

    const numericStats = columnTypes.numeric.map(col => calculateStats(col)).filter(Boolean) as ColumnStats[];
    const categoricalStats = columnTypes.categorical.map(col => calculateCategoricalStats(col)).filter(Boolean) as CategoricalStats[];

    // Find insights
    const highestAvg = numericStats.length > 0 ? _.maxBy(numericStats, 'avg') : null;
    const highestVariance = numericStats.length > 0 ? _.maxBy(numericStats, 'stdDev') : null;
    const mostUniform = numericStats.length > 0 ? _.minBy(numericStats, 'stdDev') : null;

    // Check for warnings
    const emptyColumns = csvData.headers.filter(h => {
      const nonEmpty = csvData.rows.filter(row => row[h] !== null && row[h] !== undefined && row[h] !== '');
      return nonEmpty.length === 0;
    });

    const uniformColumns = numericStats.filter(stat => stat.stdDev < 0.01);

    // Calculate correlations for selected numeric columns
    const correlations: Array<{ col1: string; col2: string; correlation: number }> = [];
    if (selectedNumericColumns.length >= 2) {
      for (let i = 0; i < selectedNumericColumns.length; i++) {
        for (let j = i + 1; j < selectedNumericColumns.length; j++) {
          const corr = calculateCorrelation(selectedNumericColumns[i], selectedNumericColumns[j]);
          if (corr !== null) {
            correlations.push({
              col1: selectedNumericColumns[i],
              col2: selectedNumericColumns[j],
              correlation: corr,
            });
          }
        }
      }
    }

    const strongCorrelations = correlations.filter(c => Math.abs(c.correlation) > 0.7);

    return (
      <div className="space-y-6">
        <h3 className="text-xl font-semibold text-gray-800">Data Summary</h3>
        
        {/* Warnings */}
        {(emptyColumns.length > 0 || uniformColumns.length > 0) && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <h4 className="font-semibold text-yellow-800 mb-2">Data Quality Warnings</h4>
                <ul className="text-sm text-yellow-700 space-y-1">
                  {emptyColumns.length > 0 && (
                    <li>Empty columns detected: {emptyColumns.join(', ')}</li>
                  )}
                  {uniformColumns.length > 0 && (
                    <li>Uniform columns (low variance): {uniformColumns.map(s => s.column).join(', ')}</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-4">
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
            <p className="text-sm text-gray-600">Total Records</p>
            <p className="text-2xl font-bold text-blue-700">{csvData.rows.length}</p>
          </div>

          <div className="bg-green-50 p-4 rounded-lg border border-green-200">
            <p className="text-sm text-gray-600">Numeric Columns</p>
            <p className="text-2xl font-bold text-green-700">{columnTypes.numeric.length}</p>
          </div>

          <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
            <p className="text-sm text-gray-600">Categorical Columns</p>
            <p className="text-2xl font-bold text-purple-700">{columnTypes.categorical.length}</p>
          </div>
        </div>

        {/* Key Insights */}
        {(highestAvg || highestVariance || strongCorrelations.length > 0) && (
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-lg border border-blue-200">
            <div className="flex items-start gap-2">
              <TrendingUp className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <h4 className="font-semibold text-gray-800 mb-2">Key Insights</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  {highestAvg && (
                    <li>Highest average: {highestAvg.column} ({highestAvg.avg.toFixed(2)})</li>
                  )}
                  {highestVariance && (
                    <li>Most variable: {highestVariance.column} (σ = {highestVariance.stdDev.toFixed(2)})</li>
                  )}
                  {mostUniform && (
                    <li>Most consistent: {mostUniform.column} (σ = {mostUniform.stdDev.toFixed(2)})</li>
                  )}
                  {strongCorrelations.map(corr => (
                    <li key={`${corr.col1}-${corr.col2}`}>
                      Strong correlation: {corr.col1} ↔ {corr.col2} (r = {corr.correlation.toFixed(3)})
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Numeric Statistics */}
        {numericStats.length > 0 && (
          <div>
            <h4 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <BarChart3 className="w-5 h-5" />
              Statistical Analysis (Numeric Columns)
            </h4>
            <div className="space-y-3">
              {numericStats.map((stat) => (
                <div
                  key={stat.column}
                  className="bg-white p-4 rounded-lg border border-gray-200"
                >
                  <h5 className="font-semibold text-gray-700 mb-3">{stat.column}</h5>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-gray-600">Count:</span>{' '}
                      <span className="font-medium">{stat.count}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Missing:</span>{' '}
                      <span className="font-medium">{stat.missing}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Mean:</span>{' '}
                      <span className="font-medium">{stat.avg.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Median:</span>{' '}
                      <span className="font-medium">{stat.median.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Std Dev:</span>{' '}
                      <span className="font-medium">{stat.stdDev.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Min:</span>{' '}
                      <span className="font-medium">{stat.min.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Max:</span>{' '}
                      <span className="font-medium">{stat.max.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Sum:</span>{' '}
                      <span className="font-medium">{stat.sum.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">25th %ile:</span>{' '}
                      <span className="font-medium">{stat.p25.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">75th %ile:</span>{' '}
                      <span className="font-medium">{stat.p75.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Categorical Statistics */}
        {categoricalStats.length > 0 && (
          <div>
            <h4 className="text-lg font-semibold text-gray-800 mb-3">
              Categorical Analysis
            </h4>
            <div className="space-y-3">
              {categoricalStats.map((stat) => (
                <div
                  key={stat.column}
                  className="bg-white p-4 rounded-lg border border-gray-200"
                >
                  <h5 className="font-semibold text-gray-700 mb-2">{stat.column}</h5>
                  <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                    <div>
                      <span className="text-gray-600">Unique values:</span>{' '}
                      <span className="font-medium">{stat.uniqueCount}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Missing:</span>{' '}
                      <span className="font-medium">{stat.missing}</span>
                    </div>
                  </div>
                  <div className="text-sm">
                    <span className="text-gray-600 font-medium">Top values:</span>
                    <div className="mt-2 space-y-1">
                      {stat.topValues.slice(0, 5).map((v, idx) => (
                        <div key={idx} className="flex justify-between items-center">
                          <span className="text-gray-700">{v.value}</span>
                          <span className="text-gray-600">({v.count})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Correlation Matrix */}
        {correlations.length > 0 && (
          <div className="bg-white p-4 rounded-lg border border-gray-200">
            <h4 className="text-lg font-semibold text-gray-800 mb-3">Correlation Analysis</h4>
            <div className="space-y-2 text-sm">
              {correlations.map((corr, idx) => (
                <div key={idx} className="flex justify-between items-center">
                  <span className="text-gray-700">{corr.col1} ↔ {corr.col2}</span>
                  <span className={`font-medium ${Math.abs(corr.correlation) > 0.7 ? 'text-red-600' : 'text-gray-600'}`}>
                    r = {corr.correlation.toFixed(3)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const toggleNumericColumn = (column: string) => {
    setSelectedNumericColumns(prev => 
      prev.includes(column) 
        ? prev.filter(c => c !== column)
        : [...prev, column]
    );
  };

  const toggleCategoricalColumn = (column: string) => {
    setSelectedCategoricalColumns(prev => 
      prev.includes(column) 
        ? prev.filter(c => c !== column)
        : [...prev, column]
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-sm p-6 mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            CSV Data Report Generator
          </h1>
          <p className="text-gray-600 mb-6">
            Upload a CSV file to generate interactive D3 charts and analytical reports
          </p>

          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors">
            <label
              htmlFor="csv-upload"
              className="cursor-pointer flex flex-col items-center"
            >
              <Upload className="w-12 h-12 text-gray-400 mb-3" />
              <span className="text-sm text-gray-600 mb-2">
                Click to upload CSV file
              </span>
              {fileName && (
                <span className="text-sm font-medium text-blue-600">
                  {fileName}
                </span>
              )}
              <input
                id="csv-upload"
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Column Selection Panel */}
        {!isLoading && csvData && (
          <div className="bg-white rounded-lg shadow-sm p-6 mb-8">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Configure Visualizations</h3>
            
            <div className="space-y-4">
              {/* Label Column Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Label Column (X-axis / Categories)
                </label>
                <select
                  value={labelColumn}
                  onChange={(e) => setLabelColumn(e.target.value)}
                  className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {csvData.headers.map(header => (
                    <option key={header} value={header}>{header}</option>
                  ))}
                </select>
              </div>

              {/* Numeric Columns Selection */}
              {columnTypes.numeric.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Numeric Columns to Visualize
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {columnTypes.numeric.map(col => (
                      <button
                        key={col}
                        onClick={() => toggleNumericColumn(col)}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          selectedNumericColumns.includes(col)
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {col}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Categorical Columns Selection */}
              {columnTypes.categorical.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Categorical Columns to Analyze
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {columnTypes.categorical.map(col => (
                      <button
                        key={col}
                        onClick={() => toggleCategoricalColumn(col)}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          selectedCategoricalColumns.includes(col)
                            ? 'bg-purple-500 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {col}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {isLoading && (
          <div className="space-y-8">
            <div className="bg-white rounded-lg shadow-sm p-6">
              <Skeleton height={30} width={200} className="mb-4" />
              <Skeleton count={3} height={80} className="mb-2" />
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="bg-white rounded-lg shadow-sm p-6">
                <Skeleton height={300} />
              </div>
              <div className="bg-white rounded-lg shadow-sm p-6">
                <Skeleton height={300} />
              </div>
            </div>
          </div>
        )}

        {!isLoading && csvData && (
          <div className="space-y-8">
            <div className="bg-white rounded-lg shadow-sm p-6">
              {generateTextualReport()}
            </div>

            {selectedNumericColumns.length > 0 && (
              <div className="grid md:grid-cols-2 gap-6">
                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">
                    Line Chart - Trend Analysis
                  </h3>
                  <div ref={lineChartRef} className="w-full"></div>
                </div>

                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">
                    Bar Chart - Aggregated by Category
                  </h3>
                  <div ref={barChartRef} className="w-full"></div>
                </div>

                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">
                    Pie Chart - Distribution Analysis
                  </h3>
                  <div ref={pieChartRef} className="w-full flex justify-center"></div>
                </div>
              </div>
            )}

            {selectedCategoricalColumns.length > 0 && (
              <div className="bg-white rounded-lg shadow-sm p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">
                  Categorical Frequency Analysis
                </h3>
                <div ref={categoricalChartRef} className="w-full"></div>
              </div>
            )}
          </div>
        )}

        {!isLoading && !csvData && (
          <div className="text-center py-12">
            <p className="text-gray-500">
              Upload a CSV file to see your data visualization and report
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default ReportPage;