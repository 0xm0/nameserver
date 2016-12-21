/*
 * This module handles all IO called on the cache (currently Redis)
 */

var url = require('url');
var factory = require('./redis');
var LruCache = require('./lru');
var async = require('async');
var tld = require('tldjs');

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
return;
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
Cache.prototype.getNSList = function(cb) {
	var self = this;

	var readFromCache = function(hostKey, cb) {

		// Let's try the LRU cache first
		var rows = this.lru.get(hostKey);

		if (rows) {
			return cb(rows.slice(0));
		}

		// The entry is not in the LRU cache, let's do a request on Redis
		this.client.read([hostKey], 'NS', function(err, rows) {
			this.lru.set(hostKey, rows);
			cb(rows.slice(0));
		}.bind(this));
	}.bind(this);

	readFromCache('nameserver', function(rows) {
		var servers = rows.shift();

		var nameservers = [];

		function loop() {

			var server = servers.splice(0, 3);

			if (server.length == 0) {
				return cb(null, nameservers)
			}

			nameservers.push({
				name : server.shift(),
				ttl : server.shift(),
				address : server.shift()
			});
			loop();
		}

		loop();

	});

};
Cache.prototype.getSOAList = function(name, cb) {
	var self = this;

	var readFromCache = function(hostKey, cb) {
		// Let's try the LRU cache first
		var rows = this.lru.get(hostKey);

		if (rows) {
			return cb(rows.slice(0));
		}

		// The entry is not in the LRU cache, let's do a request on Redis
		this.client.read([hostKey], 'SOA', function(err, rows) {
			this.lru.set(hostKey, rows);
			cb(rows.slice(0));
		}.bind(this));
	}.bind(this);

	function setSoa(server) {
		self.getNSList(function(err, nameservers) {

			if (err) {
				return cb(true)
			}
			var nameserver = nameservers.shift();

			var soa = {
				"name" : server.shift(),
				"ttl" : server.shift(),
				"primary" : nameserver.name,
				"admin" : server.shift(),
				"serial" : server.shift(),
				"refresh" : server.shift(),
				"retry" : server.shift(),
				"expiration" : server.shift(),
				"minimum" : server.shift()
			};

			cb(null, soa);

		});
	}

	readFromCache(name, function(rows) {
		var server = rows.shift();
		if (server.length == 0) {
			return readFromCache('nameserver', function(rows) {
				var server = rows.shift();
				setSoa(server);
			});
		}
		setSoa(server);
	});
};
Cache.prototype.getAnswerList = function(questions, cb) {
	var self = this;
	var answers = [];

	async.parallel(questions.map(function(question) {
		return function(next) {
			self.getDnsFromHostType(question.name, question.type, function(err, data) {
				if (err) {
					return next();
				}

				async.parallel(data.backends.map(function(ip) {
					return function(next) {
						answers.push({
							registered : true,
							host : question.name,
							name : question.name,
							type : data.type,
							zone : tld.getDomain(question.name),
							ttl : data.ttl,
							priority : data.priority,
							value : ip,
							ip : ip,
							data : data.data
						});

						next();

					};
				}), next);
			});
		};
	}), function() {
		cb(null, answers.filter(function(a) {
			return a;
		}));
	});

};

module.exports = Cache;
