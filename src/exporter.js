'use strict';
/**
 * exporter.js — Multi-format export: CSV, JSON, NDJSON, TSV, XML, XLSX
 */

const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');
const XLSX = require('xlsx');

const EXPORTS_DIR = path.join(__dirname, '..', 'exports');
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function flatten(obj, prefix = '', res = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, key, res);
    } else if (Array.isArray(v)) {
      res[key] = v.map(i => (typeof i === 'object' ? JSON.stringify(i) : i)).join(' | ');
    } else {
      res[key] = v;
    }
  }
  return res;
}

class Exporter {
  constructor(outputDir = EXPORTS_DIR) {
    this.outputDir = outputDir;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  }

  _path(name, ext) {
    return path.join(this.outputDir, `${name}_${timestamp()}.${ext}`);
  }

  exportCSV(data, options = {}) {
    const { filename = 'amazon_products', flattenNested = true } = options;
    const rows = flattenNested ? data.map(d => flatten(d)) : data;
    const parser = new Parser({ defaultValue: '' });
    const csv = parser.parse(rows);
    const fp = this._path(filename, 'csv');
    fs.writeFileSync(fp, csv, 'utf8');
    return fp;
  }

  exportTSV(data, options = {}) {
    const { filename = 'amazon_products', flattenNested = true } = options;
    const rows = flattenNested ? data.map(d => flatten(d)) : data;
    const parser = new Parser({ defaultValue: '', delimiter: '\t' });
    const tsv = parser.parse(rows);
    const fp = this._path(filename, 'tsv');
    fs.writeFileSync(fp, tsv, 'utf8');
    return fp;
  }

  exportJSON(data, options = {}) {
    const { filename = 'amazon_products', pretty = true } = options;
    const fp = this._path(filename, 'json');
    fs.writeFileSync(fp, JSON.stringify(data, null, pretty ? 2 : 0), 'utf8');
    return fp;
  }

  exportNDJSON(data, options = {}) {
    const { filename = 'amazon_products' } = options;
    const fp = this._path(filename, 'ndjson');
    const content = data.map(d => JSON.stringify(d)).join('\n');
    fs.writeFileSync(fp, content, 'utf8');
    return fp;
  }

  exportXML(data, options = {}) {
    const { filename = 'amazon_products' } = options;
    const toXML = (obj, tag = 'item') => {
      const inner = Object.entries(obj).map(([k, v]) => {
        const safeKey = k.replace(/[^a-zA-Z0-9_]/g, '_');
        if (Array.isArray(v)) {
          return `<${safeKey}>${v.map(i => `<item>${typeof i === 'object' ? toXML(i) : escXML(String(i))}</item>`).join('')}</${safeKey}>`;
        }
        if (v !== null && typeof v === 'object') return toXML(v, safeKey);
        return `<${safeKey}>${escXML(String(v ?? ''))}</${safeKey}>`;
      }).join('\n    ');
      return `  <${tag}>\n    ${inner}\n  </${tag}>`;
    };
    const escXML = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const body = data.map(d => toXML(d, 'product')).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<products>\n${body}\n</products>`;
    const fp = this._path(filename, 'xml');
    fs.writeFileSync(fp, xml, 'utf8');
    return fp;
  }

  exportXLSX(data, options = {}) {
    const { filename = 'amazon_products', flattenNested = true } = options;
    const rows = flattenNested ? data.map(d => flatten(d)) : data;
    const ws = XLSX.utils.json_to_sheet(rows);

    // Style header row
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[cell]) ws[cell].s = { font: { bold: true }, fill: { fgColor: { rgb: 'F97316' } } };
    }

    // Auto column widths
    ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.max(k.length, 12) }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Products');

    // Metadata sheet
    const meta = XLSX.utils.aoa_to_sheet([
      ['Export Date', new Date().toISOString()],
      ['Total Products', data.length],
      ['Generator', 'ASIN Harvester v1.0'],
    ]);
    XLSX.utils.book_append_sheet(wb, meta, 'Metadata');

    const fp = this._path(filename, 'xlsx');
    XLSX.writeFile(wb, fp);
    return fp;
  }

  export(format, data, options = {}) {
    if (!data || !data.length) throw new Error('No data to export');
    switch (format.toLowerCase()) {
      case 'csv':   return this.exportCSV(data, options);
      case 'tsv':   return this.exportTSV(data, options);
      case 'json':  return this.exportJSON(data, options);
      case 'ndjson':return this.exportNDJSON(data, options);
      case 'xml':   return this.exportXML(data, options);
      case 'xlsx':  return this.exportXLSX(data, options);
      default:      throw new Error(`Unknown format: ${format}`);
    }
  }
}

module.exports = { Exporter };
