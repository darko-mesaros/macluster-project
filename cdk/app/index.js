const express = require('express');
const app = express();
var morgan = require('morgan');
var template = require('lodash.template');
var fs = require('fs');
var indexPage = template(fs.readFileSync('index.html'));
var os = require('os');
const superagent = require('superagent');
var osu = require('node-os-utils')
var cpu = osu.cpu;
const si = require('systeminformation');

const port = 3000;
var selfHostname = require('os').hostname();

// A little request log
app.use(morgan('tiny'));

// General Info
var cpuInfoManufacturer, cpuInfoBrand, cpuTemperature, cpuSpeed;
var osPlatform, osDistro, osRelease, osArch;

var cpu;
var network;
var metadata = {
  ContainerInstanceTags: {
    device: 'base' // Default when no device number is known
  }
};
var page = 'Not rendered yet, might not have access to the metadata endpoint.';
var bucketURL = process.env.STATIC_URL;
var driveUtilization = 0;
var cpuUtilization = 0;
var memoryUtilization = 0;
var temp = 37;
var inMb = 0;
var outMb = 0;

function getUptime() {
  var uptime = os.uptime();
  const date = new Date(uptime * 1000);
  const days = date.getUTCDate() - 1,
    hours = date.getUTCHours(),
    minutes = date.getUTCMinutes(),
    seconds = date.getUTCSeconds(),
    milliseconds = date.getUTCMilliseconds();


  let segments = [];

  // Format the uptime string.
  if (days > 0) segments.push(days + ' day' + ((days == 1) ? '' : 's'));
  if (hours > 0) segments.push(hours + ' hour' + ((hours == 1) ? '' : 's'));
  if (minutes > 0) segments.push(minutes + ' minute' + ((minutes == 1) ? '' : 's'));
  //if (seconds > 0) segments.push(seconds + ' second' + ((seconds == 1) ? '' : 's'));
  //if (milliseconds > 0) segments.push(milliseconds + ' millisecond' + ((seconds == 1) ? '' : 's'));
  const dateString = segments.join(', ');

  return dateString;
}

function getTotalMemory() {
  var total_memory = os.totalmem();
}


function getCPU() {
  cpu.usage()
    .then(cpuPercentage => {
      cpuUtilization = cpuPercentage
    })
}

function getDiskUsage() {
  var drive = osu.drive
  drive.info()
    .then(info => {
      driveUtilization = Math.floor(info.usedPercentage);
    })
}

function getMemory() {
  var mem = osu.mem

  mem.info()
    .then(info => {
      memoryUtilization = 100 - Math.floor(info.freeMemPercentage);
    })
}

function collectStats() {
  getCPU();
  getMemory();

  page = indexPage({
    hostname: selfHostname,
    uptime: getUptime(),
    bucket: bucketURL,
    cpu: Math.floor(cpuUtilization),
    disk: driveUtilization,
    memory: memoryUtilization,
    bla: metadata.ContainerInstanceTags.device,
    hostname: os.hostname(),
    inMb: inMb,
    outMb: outMb,
    totalRam: Math.floor(os.totalmem()/(1024*1024)),
    cpuInfo: cpuInfoManufacturer + ' ' + cpuInfoBrand + ' running at ' + cpuSpeed + ' Ghz',
    temp: cpuTemperature,
    osInfo: osDistro + ' Version: ' + osRelease + ' ' + osArch,
  });
}

console.log(`DEBUG: Just before superagent`);
superagent
  .get(`${process.env.ECS_CONTAINER_METADATA_URI_V4}/taskWithTags`)
  .end((err, res) => {
    if (err) {
      console.error(err);
    } else {
      metadata = res.body;
    }
  });

si.cpu()
  .then(data => {
    cpuInfoManufacturer = data.manufacturer;
    cpuInfoBrand = data.brand;
    cpuSpeed = data.speed;
  })
  .catch(error => console.log(error));

si.cpuTemperature()
  .then(data => {
    cpuTemperature = data.main;
  })
  .catch(error => console.log(error));
si.osInfo()
  .then(data => {
    osPlatform = data.platform;
    osDistro = data.distro;
    osRelease = data.release;
    osArch = data.arch;
  })
  .catch(error => console.log(error));

collectStats();
getDiskUsage();

var collectStatsInterval = setInterval(collectStats, 1000); // Gather every 1 second going forward
var collectDriveInterval = setInterval(getDiskUsage, 60000);

app.get('/', (req, res) => {
  res.send(page);
});

process.on('SIGTERM', function () {
  // On quit clear the interval
  clearInterval(collectStatsInterval);
})

app.listen(port, () => {
  console.log(`App listening at http://${selfHostname}:${port}`);
});
