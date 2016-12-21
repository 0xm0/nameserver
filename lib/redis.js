var redis = require('redis');
var util = require('util');
var EventEmitter = require('events').EventEmitter

var Redis = function(driver) {
	EventEmitter.apply(this, arguments);

	// The principal redis client
	var clientReady = false;
	var client = redis.createClient(driver.port || 6379, driver.host || '127.0.0.1');

	if (driver.auth) {
		client.auth(driver.auth);
	}
	var prefix = '';
	if (driver.prefix) {
		prefix = driver.prefix;
	}

	if (driver.db) {
		client.select(driver.db);
	}

	client.on('error', function(err) {
		console.log(err)
	}.bind(this));

	client.on('ready', function(err) {

		console.log('ready')
	}.bind(this));

	Object.defineProperty(this, 'connected', {
		get : function() {
			return client.connected && (!clientWrite || clientWrite.connected);
		}
	});

	this.read = function(hosts, type, callback) {
		var multi = client.multi();
		var first = hosts[0];
		hosts.forEach(function(host) {
			//console.log(prefix + type + ':' + host)
			multi.lrange(prefix + type + ':' + host, 0, -1);
		});

		multi.exec(function(err, data) {
			
			callback(err, data);
		});
	};
	this.create = function(host, vhost, callback) {
		client.rpush(prefix + 'frontend:' + host, vhost, callback);
	};

	this.add = this.create;

};
util.inherits(Redis, EventEmitter);

module.exports = Redis;
