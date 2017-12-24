#!/usr/bin/env node

var program = require('commander');
var cluster = require('cluster');
var path = require('path');
var ndns = require('native-dns-nameserver');
var async = require('async');
var tld = require('tldjs');
var Logger = require('raft-logger-redis').Logger;

program.version(require('../package.json').version);

var server = program.command('server');
server.description('Run the nameserver.');

server.option('-i, --ipv6', 'use ipv6 (default: false)', false);
server.option('-I, --ipv6-addr [HOST]', 'use ipv6 (default: ::)', "::");
server.option('-a, --addr [HOST]', 'Bind to HOST address (default: 127.0.0.1)', '127.0.0.1');
server.option('-p, --port [PORT]', 'Use PORT (default: 53)', 53);
server.option('-p, --port-udp [PORT-UDP]', 'Use PORT (default: 53)', 53);
server.option('-A, --redis-addr [HOST]', 'Connect to redis HOST address (default: 127.0.0.1)', '127.0.0.1');
server.option('-P, --redis-port [PORT]', 'Connect to redis PORT (default: 6379)', 6379);
server.option('-o, --redis-auth [PASSWORD]', 'Use redis auth');
server.option('-t, --tcp', 'Start TCP-Server', false);
server.option('-u, --udp', 'Start UDP-Server', false);
server.option('-c, --cluster', 'Start server as cluster', false);

server.option('-l, --logging', 'Start logging (default: false)', false);
server.option('-v, --log-udp-port [LOG-UDP-PORT]', 'Use PORT (default: 5001)', 5001);
server.option('-x, --log-tcp-port [LOG-TCP-PORT]', 'Use PORT (default: 5000)', 5000);
server.option('-y, --log-host [HOST]', 'Use HOST (default: 127.0.0.1)', '127.0.0.1');
server.option('-z, --session [SESSION]', 'Use SESSION (default: dns)', 'DNS');
server.option('-f, --channel [CHANNEL]', 'Use CHANNEL (default: ns.0)', 'ns.0');
server.option('-g, --source [SOURCE]', 'Use SOURCE (default: dns)', 'dns');
server.action(function(options) {

    var logHandler;
    var redis = {
        host : options.redisAddr,
        port : options.redisPort
    };

    if (options.redisAuth) {
        redis.auth = options.redisAuth;
    }

    if (options.logging) {
        var logs = Logger.createLogger({
            "web" : {
                "port" : options.logTcpPort,
                "host" : options.logHost
            },
            "udp" : {
                "port" : options.logUdpPort,
                "host" : options.logHost
            },
            "view" : {
                "port" : options.logTcpPort,
                "host" : options.logHost
            }
        });

        logHandler = logs.create({
            source : options.source,
            channel : options.channel,
            session : options.session,
            bufferSize : 1
        });
    }

    process.on('uncaughtException', function(err) {
        (logHandler || console).log(err)
    });
    var cache = require('../lib/cache')(redis, {
        logHandler : logHandler
    });

    var ns = require('../lib/ddns').create(cache);

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

    function setupServer(server, type) {
        server.on('error', function(err) {
            (logHandler || console).log(err)
        });
        server.on('socketError', function(err) {
            (logHandler || console).log(err)
        });
        server.on('request', ns);
        server.on('listening', function() {
            (logHandler || console).info(type + ' Server running: ', server.address().address + ':' + server.address().port);
        });
    }

    function tcp() {
        if (options.tcp) {
            var tcpDns = ndns.createTCPServer();
            setupServer(tcpDns, 'TCP');
            tcpDns.serve(options.port);
        }
    }

    function udp() {
        if (options.udp) {
            var udpDns = ndns.createServer();
            setupServer(udpDns, 'UDP');
            udpDns.serve(options.portUdp);

            if (options.ipv6) {
                var udpDns = ndns.createServer({
                    dgram_type : 'udp6'
                });
                setupServer(udpDns, 'UDP');
                udpDns.serve(options.portUdp);
            }

        }
    }

});

program.parse(process.argv);

if (!program.args.length)
    program.help();
