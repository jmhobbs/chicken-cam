var http = require('http'),
    fs = require('fs');

var HTTPD_PORT = process.env.PORT || 8000,
    // How long since the last request for a new frame before we go to sleep?
    SLEEP_TIMEOUT = process.env.SLEEP_TIMEOUT || 2000,
    // When asleep, how often to check if we should wake up?
    WAKE_CHECK_INTERVAL = process.env.WAKE_CHECK_INTERVAL || 2000,
    // On HTTP request errors, how long to wait before trying again?
    BACKOFF_INTERVAL = process.env.BACKOFF_INTERVAL || 500,
    // How long should we wait between frames?
    REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 150,
    // Spew debug messages. Spew.
    DEBUG = ('TRUE' === (process.env.DEBUG || 'FALSE'));

var webcam_request_options = {
  host: process.env.WEBCAM_HOST || 'localhost',
  path: process.env.WEBCAM_PATH || '/',
  port: process.env.WEBCAM_PORT || 8080,
  encoding: null
};

if( DEBUG ) {
  console.log(' ===== Configuration Summary =====');
  console.log(' =          HTTPD_PORT:', HTTPD_PORT);
  console.log(' =       SLEEP_TIMEOUT:', SLEEP_TIMEOUT);
  console.log(' = WAKE_CHECK_INTERVAL:', WAKE_CHECK_INTERVAL);
  console.log(' =    BACKOFF_INTERVAL:', BACKOFF_INTERVAL);
  console.log(' =    REFRESH_INTERVAL:', REFRESH_INTERVAL);
  console.log(' =         WEBCAM_HOST:', webcam_request_options.host);
  console.log(' =         WEBCAM_PORT:', webcam_request_options.port);
  console.log(' =         WEBCAM_PATH:', webcam_request_options.path);
}

// State
var current_frame,
    current_frame_timestamp,
    last_request = +(new Date()),
    web_root = fs.realpathSync('./httpdocs');

// content-type detection for lazy bums
var extensions_content_types = {'jpg': 'image/jpeg', 'png': 'image/png'},
    content_type_for_path = function ( path ) {
      var match = path.match(/\.([a-z0-4]*)$/);
      if( null === match ) { return 'application/octet-stream'; }
      return extensions_content_types[match[1]];
    };

// HTML "template"
var index_template = fs.readFileSync('./templates/index.html', {encoding: 'utf8'});

// Stats
var started = +(new Date()),
    frames_fetched = 0,
    frames_served = 0,
    frames_failed = 0,
    sleeps = 0,
    wakeups = 0,
    is_asleep = false,
    mean_fetch_duration = 0,
    fetch_start = 0;

/////////////////////////////////////////////////////////////////////////

var webcamRequestCallback = function( response ) {
  var frame = '';

  response.setEncoding('binary');

  response.on('data', function ( chunk ) { frame += chunk; });

  response.on('end', function () {
    current_frame = frame;
    current_frame_timestamp = +(new Date());
    frames_fetched++;
    var fetch_duration = current_frame_timestamp - fetch_start;
    mean_fetch_duration = mean_fetch_duration + ((fetch_duration - mean_fetch_duration) / frames_fetched);
    if( DEBUG ) { 
      console.log("Frame complete, duration: " + fetch_duration);
      console.log("New mean duration: " + mean_fetch_duration);
    }
    setTimeout(fetchFrame, Math.max(0, Math.floor(REFRESH_INTERVAL - fetch_duration)));
  });
};

var webcamRequestError = function (e) { 
  if( DEBUG ) { console.log('Error getting image;', e); } 
  frames_failed++; 
  setTimeout(fetchFrame, BACKOFF_INTERVAL);
};

var fetchFrame = function () {
  if(( +(new Date()) - last_request ) > SLEEP_TIMEOUT) {
    if( ! is_asleep ) {
      if( DEBUG ) { console.log('Going to sleep.'); }
      is_asleep = true;
      sleeps++;
    }
    setTimeout(fetchFrame, WAKE_CHECK_INTERVAL);
  }
  else {
    if( is_asleep ) {
      if( DEBUG ) { console.log('Woke up.'); }
      is_asleep = false;
      wakeups++;
    }
    if( DEBUG ) { console.log('Requesting new frame.'); }
    fetch_start = +new Date();
    http.request(webcam_request_options, webcamRequestCallback)
      .on('error', webcamRequestError)
      .end();
  }
};

/////////////////////////////////////////////////////

var http_server = http.createServer(function (request, response) {
  if( DEBUG ) { console.log('Incoming Request:', request.url); }

  if(request.url === '/') {
    last_request = +(new Date());
    // Use our templating for "smart" client side intervals
    data = index_template
      .replace('{{ERROR_RETRY_TIMEOUT}}', Math.floor(BACKOFF_INTERVAL + mean_fetch_duration))
      .replace('{{UPDATE_INTERVAL}}', Math.min(REFRESH_INTERVAL, Math.floor(mean_fetch_duration)));
    response.writeHead(200, {"Content-Type": 'text/html', "Content-Length": data.length});
    response.end(data);
  }
  else if (request.url === '/status.json' ) {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      uptime: Math.floor(((+new Date()) - started) / 1000),
      frames: {
        fetched: frames_fetched,
        failed: frames_failed,
        served: frames_served
      },
      mean_fetch_duration: mean_fetch_duration,
      sleeps: sleeps,
      wakeups: wakeups,
      is_asleep: is_asleep,
      config: {
        SLEEP_TIMEOUT: SLEEP_TIMEOUT,
        WAKE_CHECK_INTERVAL: WAKE_CHECK_INTERVAL,
        BACKOFF_INTERVAL: BACKOFF_INTERVAL,
        REFRESH_INTERVAL: REFRESH_INTERVAL
      }
    }));
  }
  else if (request.url.substr(0, 6) === '/image') {
    last_request = +(new Date());
    frames_served++;
    response.writeHead(200, {"Content-Type": "image/jpeg"});
    response.end(current_frame, 'binary');
  }
  else {
    fs.realpath(web_root + request.url, function (err, resolved_path) {

      if( undefined === resolved_path ) {
        response.writeHead(404, {'Content-Type': 'text/plain'});
        response.end('404 - Not Found');
        return;
      }

      if( err ) {
        response.writeHead(500, {'Content-Type': 'text/plain'});
        response.end('500 - Internal Server Error');
        return;
      }

      // stay in the web root
      if( 0 !== resolved_path.indexOf(web_root) ) {
        response.writeHead(403, {'Content-Type': 'text/plain'});
        response.end('403 - Forbidden');
        return;
      }

      fs.readFile(resolved_path, function read(err, data) {
        
        if (err) {
          response.writeHead(500, {'Content-Type': 'text/plain'});
          response.end('500 - Internal Server Error');
        }

        response.writeHead(200, {"Content-Type": content_type_for_path(resolved_path), "Content-Length": data.length});
        response.end(data, 'binary');
      });

    });
  }
});

http_server.listen(HTTPD_PORT);
fetchFrame();
