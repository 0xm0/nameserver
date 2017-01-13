/*
 * This module handles all IO called on the cache (currently Redis)
 */

var url = require('url');
var factory = require('./redis');
var LruCache = require('./lru');
var async = require('async');
var tld = require('tldjs');

function Cache(config, options) {
	if (!(this instanceof Cache)) {
		return new Cache(config, options);
	}

	this.config = config;

	this.log = function(msg) {
		if (options.logHandler)
			options.logHandler.log(msg);
		else
			console.log(msg);
	};

	this.client = new factory(config);

	this.client.on('error', function(err) {
		this.log('DriverError ' + err);
	}.bind(this));

	this.lru = new LruCache();
	return;
	this.lru.enabled = {
		size : 100000,
		ttl : 60
	};
}

Cache.prototype.getDomainsLookup = function(hostname) {
	var parts = hostname.split('.');
	var result = [hostname];
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

Cache.prototype.readFromCache = function(hostKey, type, callback) {
	var self = this;
	var rows = this.lru.get(hostKey);

	if (rows) {
		return callback(rows.slice(0));
	}

	// The entry is not in the LRU cache, let's do a request on Redis
	this.client.read(this.getDomainsLookup(hostKey), type, function(err, rows) {
		self.lru.set(hostKey, rows);
		callback(rows.slice(0));
	});

};

Cache.prototype.getDnsFromHostType = function(host, type, callback) {

	this.readFromCache(host, type, function(rows) {
		var backends = rows.shift();
		while (rows.length && !backends.length) {
			backends = rows.shift();
		}

		if (!backends.length) {
			var error = new Error('No hostname Configured');
			error.code = 'NOHOST';
			return callback(error);
		}
		//JSON.stringify

		for (var i = 0,
		    j = backends.length; i < j; i++) {
			backends[i] = JSON.parse(backends[i])
		};

		callback(null, backends);
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
		var backends = rows.shift();
		while (rows.length && !backends.length) {
			backends = rows.shift();
		}

		if (!backends.length) {
			var error = new Error('No hostname Configured');
			error.code = 'NOHOST';
			return callback(error);
		}

		for (var i = 0,
		    j = backends.length; i < j; i++) {
			backends[i] = JSON.parse(backends[i])
		};
		cb(null, backends);

	});

};
Cache.prototype.getSOAList = function(name, cb) {
	var self = this;
	self.log('type=' + 'SOA' + ' domain=' + name);

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
				"name" : server.name,
				"ttl" : server.ttl,
				"primary" : nameserver.name,
				"admin" : server.admin,
				"serial" : server.serial,
				"refresh" : server.refresh,
				"retry" : server.retry,
				"expiration" : server.expiration,
				"minimum" : server.minimum
			};

			cb(null, soa);

		});
	}

	readFromCache(name, function(rows) {

		var backends = rows.shift();
		while (rows.length && !backends.length) {
			backends = rows.shift();
		}

		for (var i = 0,
		    j = backends.length; i < j; i++) {
			backends[i] = JSON.parse(backends[i]);
		};

		if (backends.length == 0) {
			return readFromCache('nameserver', function(rows) {
				var backends = rows.shift();
				while (rows.length && !backends.length) {
					backends = rows.shift();
				}

				for (var i = 0,
				    j = backends.length; i < j; i++) {
					backends[i] = JSON.parse(backends[i]);
				};

				var server = backends.shift();
				setSoa(server);
			});
		}
		setSoa(backends[0]);
	});
};
Cache.prototype.lookupQuestion = function(question, cb) {
	var self = this;
	self.log('type=' + question.type + ' domain=' + question.name + ' class=' + question.class + ' address=' + question.address.address);

	self.getDnsFromHostType(question.name, question.type, function(err, data) {
		if (err) {
			return cb(err);
		}

		async.parallel(data.map(function(host) {
			return function(next) {
				next(null, {
					name : question.name,
					type : question.type,
					zone : tld.getDomain(question.name),
					ttl : host.ttl,
					priority : host.priority,
					data : host.data
				});

			};
		}), cb);
	});

};
Cache.prototype.lookupCNAME = function(question, cb) {
	var self = this;
	self.log('type=' + 'CNAME' + ' domain=' + question.name + ' class=' + question.class + ' address=' + question.address.address);

	var answers = [];
	self.getDnsFromHostType(question.name, 'CNAME', function(err, data) {
		if (err) {
			return cb(err);
		}

		async.parallel(data.map(function(host) {
			answers.push({
				name : question.name,
				type : 'CNAME',
				zone : tld.getDomain(question.name),
				ttl : host.ttl,
				priority : host.priority,
				data : host.data
			});
			return function(next) {
				self.lookupQuestion({
					name : host.data,
					type : question.type,
					class : question.class,
					address : question.address
				}, function(err, data) {

					if (err) {
						return next();
					}

					for (var i = 0; i < data.length; i++) {
						answers.push(data[i]);
					};

					next();
				});

			};
		}), function() {
			cb(null, answers)
		});
	});

};
Cache.prototype.getAnswerList = function(questions, cb) {
	var self = this;
	var answers = [];

	async.parallel(questions.map(function(question) {
		return function(next) {
			self.lookupQuestion(question, function(err, data) {
				if (err) {
					if (err.code == 'NOHOST' && question.type != 'CNAME') {
						return self.lookupCNAME(question, next);
					}
					return next();
				}
				next(null, data);
			});
		};
	}), function(err, data) {
		if (err || !data) {
			
			return cb(null, [])
		}
		var answers = data.reduce(function(prev, curr) {
			return prev.concat(curr);
		});

		cb(null, answers);
	});

};

module.exports = Cache;
