function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows) {
  return rows.map((row) => row.map(escapeCsvField).join(',')).join('\n');
}

// Flattens a nested plain object/array into [path, value] row pairs, e.g.
// { byStatus: { new: 5, won: 2 } } -> [['byStatus.new', 5], ['byStatus.won', 2]]
// Used to turn a report's JSON shape into a generic two-column CSV without
// needing bespoke tabular logic per report type.
function flattenToRows(value, prefix = '') {
  const rows = [];

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      rows.push(...flattenToRows(item, prefix ? `${prefix}.${index}` : String(index)));
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      rows.push(...flattenToRows(val, prefix ? `${prefix}.${key}` : key));
    }
  } else {
    rows.push([prefix, value]);
  }

  return rows;
}

// RFC 4180 reader for admin bulk uploads (localities, circle rates, stamp
// duty, auction lists). First row is the header; returns one object per
// data row keyed by trimmed header name. Handles quoted fields containing
// commas, newlines and doubled quotes; skips fully blank lines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const input = String(text || '').replace(/^﻿/, '');

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length === 0) return [];

  const headers = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((header, index) => {
      const value = (cells[index] ?? '').trim();
      obj[header] = value === '' ? null : value;
    });
    return obj;
  });
}

module.exports = { toCsv, flattenToRows, parseCsv };
