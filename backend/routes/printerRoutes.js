const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const authenticate = require('../middleware/authenticate');

// Local OS printer listing - not shop data, so no shopId scoping or
// license gate, but it should still require a logged-in session rather
// than being wide open to anyone who can reach the API.
router.use(authenticate);

function getFallbackPrinters() {
  return [
    "POS-80",
    "POS-58",
    "Receipt Printer",
    "Microsoft Print to PDF",
    "Fax"
  ];
}

router.get('/', (req, res) => {
  if (process.platform === 'win32') {
    // Windows: Use PowerShell
    exec('powershell -command "Get-Printer | Select-Object -ExpandProperty Name"', (psError, psStdout) => {
      if (psError) return res.json({ printers: getFallbackPrinters() });
      const printers = psStdout.split('\n').map(l => l.trim()).filter(l => l);
      res.json({ printers: printers.length > 0 ? printers : getFallbackPrinters() });
    });
  } else {
    // macOS / Linux
    exec('lpstat -p', (error, stdout) => {
      if (error) return res.json({ printers: getFallbackPrinters() });
      const printers = [];
      const lines = stdout.split('\n').filter(l => l.trim());
      lines.forEach(line => {
        if (line.startsWith('printer')) {
          const parts = line.split(' ');
          if (parts.length >= 2) printers.push(parts[1]);
        }
      });
      res.json({ printers: printers.length > 0 ? printers : getFallbackPrinters() });
    });
  }
});

module.exports = router;
