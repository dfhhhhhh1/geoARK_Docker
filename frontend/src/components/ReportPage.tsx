import { useState, useMemo } from 'react';
import Papa from 'papaparse';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line, Bar, Pie } from 'react-chartjs-2';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import { Upload, AlertCircle, TrendingUp, BarChart3 } from 'lucide-react';
import _ from 'lodash';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

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
  
  //Column selections
  const [labelColumn, setLabelColumn] = useState<string>('');
  const [selectedNumericColumns, setSelectedNumericColumns] = useState<string[]>([]);
  const [selectedCategoricalColumns, setSelectedCategoricalColumns] = useState<string[]>([]);

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

          //Auto-select first column as label
          if (headers.length > 0) {
            setLabelColumn(headers[0]);
          }

          //Auto-select first 2 numeric columns
          const numericCols = headers.filter((h) => 
            rows.length > 0 && typeof rows[0][h] === 'number'
          );
          setSelectedNumericColumns(numericCols.slice(0, 2));

          //Auto-select first categorical column
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

  //Identify column types
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

  //Calculate statistics for numeric columns
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

  //Calculate categorical statistics
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
    
    const topValues = _.orderBy(counts, 'count', 'desc').slice(0, 20);

    return {
      column,
      uniqueCount: Object.keys(grouped).length,
      topValues,
      missing: csvData.rows.length - values.length,
    };
  };

  //Calculate correlation between two numeric columns
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

  //Generate line chart with selected columns
  const generateLineChartData = () => {
    if (!csvData || csvData.rows.length === 0 || !labelColumn || selectedNumericColumns.length === 0) {
      return null;
    }

    const colors = [
      'rgb(59, 130, 246)',
      'rgb(16, 185, 129)',
      'rgb(245, 158, 11)',
      'rgb(239, 68, 68)',
      'rgb(139, 92, 246)',
    ];

    const grouped = _.groupBy(csvData.rows, row => String(row[labelColumn] || 'Unknown'));

    const labels = Object.keys(grouped).sort();

    return {
      labels: labels,
      datasets: selectedNumericColumns.map((col, idx) => ({
        label: col,
        data: csvData.rows.map(row => Number(row[col]) || 0),
        borderColor: colors[idx % colors.length],
        backgroundColor: colors[idx % colors.length].replace('rgb', 'rgba').replace(')', ', 0.1)'),
        tension: 0.3,
      })),
    };
  };

  //Generate bar chart with aggregation by category
  const generateBarChartData = () => {
    if (!csvData || csvData.rows.length === 0 || !labelColumn || selectedNumericColumns.length === 0) {
      return null;
    }

    //Group by label column and sum numeric columns
    const grouped = _.groupBy(csvData.rows, row => String(row[labelColumn] || 'Unknown'));
    
    const labels = Object.keys(grouped).slice(0, 25); //Limit to 15 categories for readability
    
    const colors = [
      'rgba(59, 130, 246, 0.7)',
      'rgba(16, 185, 129, 0.7)',
      'rgba(245, 158, 11, 0.7)',
      'rgba(239, 68, 68, 0.7)',
      'rgba(139, 92, 246, 0.7)',
    ];

    return {
      labels,
      datasets: selectedNumericColumns.map((col, idx) => ({
        label: col,
        data: labels.map(label => {
          const sum = grouped[label].reduce((acc, row) => acc + (Number(row[col]) || 0), 0);
          return sum;
        }),
        backgroundColor: colors[idx % colors.length],
      })),
    };
  };

  //Generate pie chart with proper aggregation
  const generatePieChartData = () => {
    if (!csvData || csvData.rows.length === 0 || !labelColumn || selectedNumericColumns.length === 0) {
      return null;
    }

    const firstNumericCol = selectedNumericColumns[0];
    
    //Group by label and sum the numeric column
    const grouped = _.groupBy(csvData.rows, row => String(row[labelColumn] || 'Unknown'));
    
    const aggregated = Object.entries(grouped).map(([label, rows]) => ({
      label,
      value: rows.reduce((sum, row) => sum + (Number(row[firstNumericCol]) || 0), 0),
    }));

    //Sort and take top 8
    const sorted = _.orderBy(aggregated, 'value', 'desc').slice(0, 25);

    const colors = [
      'rgba(59, 130, 246, 0.8)',
      'rgba(16, 185, 129, 0.8)',
      'rgba(245, 158, 11, 0.8)',
      'rgba(239, 68, 68, 0.8)',
      'rgba(139, 92, 246, 0.8)',
      'rgba(236, 72, 153, 0.8)',
      'rgba(20, 184, 166, 0.8)',
      'rgba(251, 146, 60, 0.8)',
    ];

    return {
      labels: sorted.map(item => item.label),
      datasets: [
        {
          label: firstNumericCol,
          data: sorted.map(item => item.value),
          backgroundColor: colors,
          borderColor: colors.map(c => c.replace('0.8', '1')),
          borderWidth: 2,
        },
      ],
    };
  };

  //Generate categorical frequency chart
  const generateCategoricalChartData = () => {
    if (!csvData || selectedCategoricalColumns.length === 0) return null;

    const column = selectedCategoricalColumns[0];
    const stats = calculateCategoricalStats(column);
    
    if (!stats) return null;

    return {
      labels: stats.topValues.map(v => v.value),
      datasets: [
        {
          label: 'Frequency',
          data: stats.topValues.map(v => v.count),
          backgroundColor: 'rgba(139, 92, 246, 0.7)',
        },
      ],
    };
  };

  //Enhanced textual report
  const generateTextualReport = () => {
    if (!csvData || csvData.rows.length === 0) return null;

    const numericStats = selectedNumericColumns
      .map(col => calculateStats(col))
      .filter(Boolean) as ColumnStats[];

    const categoricalStats = selectedCategoricalColumns
      .map(col => calculateCategoricalStats(col))
      .filter(Boolean) as CategoricalStats[];
    //Find insights
    const highestAvg = numericStats.length > 0 ? _.maxBy(numericStats, 'avg') : null;
    const highestVariance = numericStats.length > 0 ? _.maxBy(numericStats, 'stdDev') : null;
    const mostUniform = numericStats.length > 0 ? _.minBy(numericStats, 'stdDev') : null;

    //Check for warnings
    const emptyColumns = csvData.headers.filter(h => {
      const nonEmpty = csvData.rows.filter(row => row[h] !== null && row[h] !== undefined && row[h] !== '');
      return nonEmpty.length === 0;
    });

    const uniformColumns = numericStats.filter(stat => stat.stdDev < 0.01);

    //Calculate correlations for selected numeric columns
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
                      {stat.topValues.slice(0, 25).map((v, idx) => (
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

        {/* Numeric Statistics */}
        {numericStats.length > 0 && (
          <div>
            <h4 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <BarChart3 className="w-5 h-5" />
              Statistical Analysis (Numeric Columns)
            </h4>
            <div className="space-y-3">
              {numericStats
                .map((stat) => (
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

      </div>
    );
  };

  const lineData = generateLineChartData();
  const barData = generateBarChartData();
  const pieData = generatePieChartData();
  const categoricalData = generateCategoricalChartData();

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
            Upload a CSV file to generate interactive charts and analytical reports
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
                {lineData && (
                  <div className="bg-white rounded-lg shadow-sm p-6">
                    <h3 className="text-lg font-semibold text-gray-800 mb-4">
                      Line Chart - Trend Analysis
                    </h3>
                    <Line
                      data={lineData}
                      options={{
                        responsive: true,
                        plugins: {
                          legend: {
                            position: 'top',
                          },
                          tooltip: {
                            mode: 'index',
                            intersect: false,
                          },
                        },
                        scales: {
                          y: {
                            beginAtZero: true,
                          },
                        },
                      }}
                    />
                  </div>
                )}

                {barData && (
                  <div className="bg-white rounded-lg shadow-sm p-6">
                    <h3 className="text-lg font-semibold text-gray-800 mb-4">
                      Bar Chart - Aggregated by Category
                    </h3>
                    <Bar
                      data={barData}
                      options={{
                        responsive: true,
                        plugins: {
                          legend: {
                            position: 'top',
                          },
                        },
                        scales: {
                          y: {
                            beginAtZero: true,
                          },
                        },
                      }}
                    />
                  </div>
                )}

                {pieData && (
                  <div className="bg-white rounded-lg shadow-sm p-6">
                    <h3 className="text-lg font-semibold text-gray-800 mb-4">
                      Pie Chart - Distribution Analysis
                    </h3>
                    <div className="max-w-md mx-auto">
                      <Pie
                        data={pieData}
                        options={{
                          responsive: true,
                          plugins: {
                            legend: {
                              position: 'bottom',
                            },
                            tooltip: {
                              callbacks: {
                                label: function(context) {
                                  const label = context.label || '';
                                  const value = context.parsed || 0;
                                  const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0);
                                  const percentage = ((value / total) * 100).toFixed(1);
                                  return `${label}: ${value.toFixed(2)} (${percentage}%)`;
                                },
                              },
                            },
                          },
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {categoricalData && selectedCategoricalColumns.length > 0 && (
              <div className="bg-white rounded-lg shadow-sm p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">
                  Categorical Frequency Analysis
                </h3>
                <Bar
                  data={categoricalData}
                  options={{
                    responsive: true,
                    plugins: {
                      legend: {
                        display: false,
                      },
                    },
                    scales: {
                      y: {
                        beginAtZero: true,
                        title: {
                          display: true,
                          text: 'Count',
                        },
                      },
                    },
                  }}
                />
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