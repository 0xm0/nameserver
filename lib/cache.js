/*
 * This module handles all IO called on the cache (currently Redis)
 */

var url = require('url');
var factory = require('./redis');
var LruCache = require('./lru');

function Cache(config, handlers) {
	if (!(this instanceof Cache)) {
		return new Cache(config, handlers);
	}

	var logHandler = handlers.logHandler || console.log,
	    debugHandler = handlers.debugHandler || console.log;
	this.config = config;

	this.log = function(msg) {
		logHandler('Cache: ' + msg);
	};
	this.debug = function(msg) {
		debugHandler('Cache: ' + msg);
	};

	this.client = new factory(config);

	this.client.on('error', function(err) {
		this.log('DriverError ' + err);
	}.bind(this));

	// LRU cache for Redis lookups
	this.lru = new LruCache();
	this.lru.enabled = {
		size : 100000,
		ttl : 60
	};
}

/*
 * This method is an helper to get the domain name (to a given depth for subdomains)
 */
Cache.prototype.getDomainsLookup = function(hostname) {
	var parts = hostname.split('.');
	var result = [parts.join('.')];
	var n;
	// Prevent abusive lookups
	while (parts.length > 6) {
		parts.shift();
	}
	while (parts.length > 1) {
		parts.shift();
		n = parts.join('.');
		result.push('*.' + n);
	}
	result.push('*');
	return result;
};

/*
 * This method picks up a backend randomly and ignore dead ones.
 * The parsed URL of the chosen backend is returned.
 * The method also decides which HTTP error code to return according to the
 * error.
 */
Cache.prototype.getDnsFromHostType = function(host, type, callback) {

	var readFromCache = function(hostKey, cb) {
		// Let's try the LRU cache first
		var rows = this.lru.get(hostKey);

		if (rows) {
			return cb(rows.slice(0));
		}

		// The entry is not in the LRU cache, let's do a request on Redis
		this.client.read(this.getDomainsLookup(hostKey), type, function(err, rows) {
			this.lru.set(hostKey, rows);
			cb(rows.slice(0));
		}.bind(this));
	}.bind(this);

	readFromCache(host, function(rows) {
		var deads = rows.pop();
		var backends = rows.shift();
		while (rows.length && !backends.length) {
			backends = rows.shift();
		}

		if (!backends.length) {
			return callback('No Application Configured', 400);
		}

		var virtualHost = backends[0];
		var ttl = Number(backends[1]);
		var priority = Number(backends[2]);
		var data = backends[3];

		backends = backends.slice(4);

		callback(null, {
			host : virtualHost,
			ttl : ttl,
			priority : priority,
			type : type,
			data : data == 'null' ? null : data,
			backends : backends
		});
	});
};

module.exports = Cache;
