var http = require('http'),
    http_server = http.createServer(httpRouter),
    io = require('socket.io').listen(http_server),
    fs = require('fs'),
    redis_client;

/////////////////////////////////////////////////////////////////////////
// Load Config

var HTTPD_PORT = process.env.PORT || 8000,
    // On HTTP request errors, how long to wait before trying again?
    BACKOFF_INTERVAL = process.env.BACKOFF_INTERVAL || 500,
    // How long should we wait between frames?
    REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 250,
    // Spew debug messages. Spew.
    DEBUG = ('TRUE' === (process.env.DEBUG || 'FALSE')),
    // Where do we connect to socket.io?
    SOCKETIO_HOST = process.env.SOCKETIO_HOST || '/',
    // Redis URL
    REDIS_URL = (process.env.REDIS_URL || process.env.REDISTOGO_URL || process.env.OPENREDIS_URL || null),
    // Where should files be served from?
    WEB_ROOT;

var webcam_request_options = {
  host: process.env.WEBCAM_HOST || 'localhost',
  path: process.env.WEBCAM_PATH || '/',
  port: process.env.WEBCAM_PORT || 8080,
  encoding: null
};

if( DEBUG ) {
  console.log(' ===== Configuration Summary =====');
  console.log(' =        HTTPD_PORT:', HTTPD_PORT);
  console.log(' =  BACKOFF_INTERVAL:', BACKOFF_INTERVAL);
  console.log(' =  REFRESH_INTERVAL:', REFRESH_INTERVAL);
  console.log(' =     SOCKETIO_HOST:', SOCKETIO_HOST);
  console.log(' =         REDIS_URL:', REDIS_URL);
  console.log(' =       WEBCAM_HOST:', webcam_request_options.host);
  console.log(' =       WEBCAM_PORT:', webcam_request_options.port);
  console.log(' =       WEBCAM_PATH:', webcam_request_options.path);
}

/////////////////////////////////////////////////////////////////////////
// Variables and util

// init redis if we are using it
if( REDIS_URL !== null ) {
  var url = require("url").parse(REDIS_URL),
		  redis = require("redis"),
	    RedisStore = require('socket.io/lib/stores/redis'),
      pub = redis.createClient(url.port, url.hostname),
      sub = redis.createClient(url.port, url.hostname);

	redis_client = redis.createClient(url.port, url.hostname);

  if( url.auth ) {
    redis_client.auth(url.auth.split(":")[1], function (err) { if (err) { throw err; } });
    pub.auth(url.auth.split(":")[1], function (err) { if (err) { throw err; } });
    dubt.auth(url.auth.split(":")[1], function (err) { if (err) { throw err; } });
  }

	io.set('store', new RedisStore({
		redis: redis,
	  redisPub: pub,
	  redisSub: sub,
	  redisClient: redis_client
	}));

}

// State
var current_frame = null,
    is_asleep = false,
    fetch_start = 0;
    
var clients = (function () {

  var use_redis          = ('undefined' !== typeof redis_client),
      _in_memory_counter = 0,
      counter_key_name   = "chicken-cam:clients";

  if(DEBUG) { console.log('Client counter is using ' + ((use_redis) ? 'redis' : 'memory')); }

  return {
    connected: function (fn) {
      if( use_redis ) {
        redis_client.get( counter_key_name, function ( err, val ) {
          if( null === val ) { fn(0); }
          else { fn(parseInt(val, 10)); }
        });
      }
      else {
        fn(_in_memory_counter);
      }
    },
    connect: function () {
      if( use_redis ) {
        redis_client.incr(counter_key_name);
      }
      else {
        _in_memory_counter++;
      }
    },
    disconnect: function () {
      if( use_redis ) {
        redis_client.decr(counter_key_name);
      }
      else {
        _in_memory_counter--;
      }
    }
  };
}());

// content-type detection for lazy bums
var extensions_content_types = {'jpg': 'image/jpeg', 'png': 'image/png'};

function content_type_for_path ( path ) {
  var match = path.match(/\.([a-z0-4]*)$/);
  if( null === match ) { return 'application/octet-stream'; }
  return extensions_content_types[match[1]];
}

function timestamp () { return +new Date(); }

// Stats
var stats = {
      started: 0,
      frames: {
        fetched: 0,
        served: 0,
        failed: 0
      },
      sleeps: 0,
      wakeups: 0,
      mean_fetch_duration: 0
    };

/////////////////////////////////////////////////////////////////////////
// HTTP Server

/**
 * Serve the index view.
 */
function serveIndex ( response ) {
  fs.readFile('./templates/index.html', {encoding: 'utf8'}, function (err, data) {
    if( err ) { 
      response.writeHead(500, {"Content-Type": 'text/plain'});
      response.end('500 - Internal Server Error');
      return;
    }
    data = data.replace('{{ SOCKETIO_HOST }}', SOCKETIO_HOST);
    response.writeHead(200, {"Content-Type": 'text/html', "Content-Length": data.length});
    response.end(data);
  });
}

/**
 * Serve a status JSON page.
 */
function serveStatus ( response ) {
  clients.connected(function (clients_connected) {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      uptime: Math.floor((timestamp() - stats.started) / 1000),
      clients_connected: clients_connected,
      frames: stats.frames,
      mean_fetch_duration: stats.mean_fetch_duration,
      sleeps: stats.sleeps,
      wakeups: stats.wakeups,
      is_asleep: is_asleep,
      config: {
        BACKOFF_INTERVAL: BACKOFF_INTERVAL,
        REFRESH_INTERVAL: REFRESH_INTERVAL
      }
    }));
  });
}

/**
 * Serve the current webcam frame from memory.
 */
function serveFrame ( response ) {
  stats.frames.served++;
  response.writeHead(200, {"Content-Type": "image/jpeg"});
  response.end(current_frame, 'binary');
}

/**
 * Serve an arbitrary file from the WEB_ROOT directory.
 */
function serveFile ( response, path ) {
  fs.realpath(WEB_ROOT + path, function (err, resolved_path) {

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
    if( 0 !== resolved_path.indexOf(WEB_ROOT) ) {
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

function httpRouter (request, response) {
  if( DEBUG ) { console.log('Incoming Request:', request.url); }

  if(request.url === '/') {
    serveIndex(response);
  }
  else if (request.url === '/status.json' ) {
    serveStatus(response);
  }
  else if (request.url.substr(0, 6) === '/image') {
    serveFrame(response);
  }
  else {
    serveFile(response, request.url);
  }
}

/////////////////////////////////////////////////////////////////////////
// Webcam Request Loop

function webcamRequestCallback ( response ) {
  var frame = '';

  response.setEncoding('binary');

  response.on('data', function ( chunk ) { frame += chunk; });

  response.on('end', function () {
    current_frame = frame;
    io.sockets.emit('frame_ready');
    stats.frames.fetched++;
    var fetch_duration = timestamp() - fetch_start;
    stats.mean_fetch_duration = stats.mean_fetch_duration + ((fetch_duration - stats.mean_fetch_duration) / stats.frames.fetched);
    setTimeout(fetchFrame, Math.max(0, Math.floor(REFRESH_INTERVAL - fetch_duration)));
  });
}

function webcamRequestError ( err ) {
  if( DEBUG ) { console.log('Error getting image;', err); } 
  io.sockets.emit('frame_failed');
  stats.frames.failed++; 
  setTimeout(fetchFrame, BACKOFF_INTERVAL);
}

function fetchFrame () {
  clients.connected(function (clients_connected) {
    if(0 >= clients_connected && null !== current_frame) {
      if( DEBUG ) { console.log('Going to sleep.'); }
      is_asleep = true;
      stats.sleeps++;
    }
    else {
      if( is_asleep ) {
        if( DEBUG ) { console.log('Woke up.'); }
        is_asleep = false;
        stats.wakeups++;
      }
      if( DEBUG ) { console.log('Requesting new frame.'); }
      fetch_start = timestamp();
      http.request(webcam_request_options, webcamRequestCallback)
        .on('error', webcamRequestError)
        .end();
    }
  });
}

/////////////////////////////////////////////////////////////////////////
// Socket IO

io.sockets.on('connection', function (socket) {
  clients.connect();

  if( is_asleep ) { fetchFrame(); }

  socket.on('disconnect', function () {
    clients.disconnect();
  });
});

/////////////////////////////////////////////////////////////////////////
// Init or die!

fs.realpath('./httpdocs', function (err, resolved_path) {
  if( err ) { throw err; }
  WEB_ROOT = resolved_path;
  http_server.listen(HTTPD_PORT);
  stats.started = +new Date();
  fetchFrame();
});
