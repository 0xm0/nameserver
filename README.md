Welcome to nameserver!	{#welcome}
=====================

Redis backed nameserver with lru cache.

Install
---------
To install Logster you can use `npm` or `git clone`
#### <i class="icon-file"></i> NPM
```
$ sudo npm install -g nameserver
```

#### <i class="icon-file"></i> GIT
```
$ git clone https://github.com/MangoRaft/nameserver.git
$ cd nameserver
$ sudo npm install -g
```
#### Server
Starting the server is the first thing you want to do.
The servers are setup to scale. You can run it as a cluster or run each part on different servers.
```
$ logster-redis server -h


  Usage: server [options]

  Run the nameserver.

  Options:

    -h, --help                   output usage information
    -a, --addr [HOST]            Bind to HOST address (default: 127.0.0.1)
    -p, --port [PORT]            Use PORT (default: 53)
    -p, --port-udp [PORT-UDP]    Use PORT (default: 53)
    -A, --redis-addr [HOST]      Connect to redis HOST address (default: 127.0.0.1)
    -P, --redis-port [PORT]      Connect to redis PORT (default: 6379)
    -o, --redis-auth [PASSWORD]  Use redis auth
    -t, --tcp                    Start TCP-Server
    -u, --udp                    Start UDP-Server
    -c, --cluster                Start server as cluster
    -f, --nameserver             Nameserver (default: ns1.local:127.0.0.1,ns2.local:127.0.0.1)

```
#####Example
```
$ nameserver server -utc
```