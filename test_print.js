const {exec} = require('child_process'); 
exec('powershell -command "Get-Printer | Select-Object -ExpandProperty Name"', (err, stdout) => {
  console.log('---STDOUT---');
  console.log(JSON.stringify(stdout));
});
