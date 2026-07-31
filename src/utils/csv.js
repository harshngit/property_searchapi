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

module.exports = { toCsv, flattenToRows };
