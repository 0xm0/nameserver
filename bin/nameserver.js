//#!/usr/bin/env node

var program = require('commander');
var cluster = require('cluster');
var path = require('path');
var ndns = require('native-dns');
var async = require('async');
var tld = require('tldjs');

program.version(require('../package.json').version);
process.on('uncaughtException', function(err) {
	console.log(err)
});

var server = program.command('server');
server.description('Run the nameserver.');

server.option('-a, --addr [HOST]', 'Bind to HOST address (default: 127.0.0.1)', '127.0.0.1');
server.option('-p, --port [PORT]', 'Use PORT (default: 53)', 53);
server.option('-p, --port-udp [PORT-UDP]', 'Use PORT (default: 53)', 53);
server.option('-A, --redis-addr [HOST]', 'Connect to redis HOST address (default: 127.0.0.1)', '127.0.0.1');
server.option('-P, --redis-port [PORT]', 'Connect to redis PORT (default: 6379)', 6379);
server.option('-o, --redis-auth [PASSWORD]', 'Use redis auth');
server.option('-t, --tcp', 'Start TCP-Server', false);
server.option('-u, --udp', 'Start UDP-Server', false);
server.option('-c, --cluster', 'Start server as cluster', false);

server.option('-f, --nameserver', 'Nameserver (default: ns1.local:127.0.0.1,ns2.local:127.0.0.1)', 'ns1.local:127.0.0.1,ns2.local:127.0.0.1');

server.action(function(options) {

	var redis = {
		host : options.redisAddr,
		port : options.redisPort
	};

	if (options.redisAuth) {
		redis.auth = options.redisAuth;
	}

	var cache = require('../lib/cache')(redis, {});

	var nameservers = options.nameserver.split(',').map(function(name) {
		name = name.split(':');
		return {
			name : name[0],
			ipv4 : name[2]
		};
	});

	var ns = require('./ddns').create({
		primaryNameserver : nameservers[0].name,
		nameservers : nameservers,
		getAnswerList : function(questions, cb) {

			var answers = [];

			async.parallel(questions.map(function(question) {
				return function(next) {
					cache.getDnsFromHostType(question.name, question.type, function(err, data) {

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
		}
	});
	
	if (options.cluster) {
		var numCPUs = require('os').cpus().length;
		if (cluster.isMaster) {
			for (var i = 0; i < numCPUs; i++)
				cluster.fork();

		} else {
			tcp();
			udp();
		}
	} else {
		tcp();
		udp();
	}

	function setupServer(server) {
		server.on('error', ns.onError);
		server.on('socketError', ns.onSocketError);
		server.on('request', ns.onRequest);
		server.on('listening', function() {
			console.info('DNS Server running on port: ', options.port);
		});
	}

	function tcp() {
		if (options.web) {

			var tcpDns = ndns.createTCPServer();
			setupServer(tcpDns);
			tcpDns.serve(options.port, options.host);

		}
	}

	function udp() {
		if (options.udp) {

			var udpDns = ndns.createServer();
			setupServer(udpDns);
			udpDns.serve(options.port, options.host);
		}
	}

});

program.parse(process.argv);

if (!program.args.length)
	program.help();
