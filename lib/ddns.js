'use strict';

var ndns = require('native-dns-nameserver');
var tld = require('tldjs');

module.exports.create = function(store) {

    function setLocalhost(request, response, value) {
        var type = ndns.consts.QTYPE_TO_NAME[request.question[0].type];
        var name = request.question[0].name;
        var priority = 10;
        //var klass = ndns.consts.QCLASS_TO_NAME[request.question[0].class];

        response.answer.push(ndns[type]({
            name : name,
            address : value,
            ttl : 43200// 12 hours
            ,
            data : [value],
            exchange : value,
            priority : priority || 10
        }));
    }

    function getSoa(request, cb) {

        store.getSOAList(tld.getDomain(request.question[0].name.replace('*', '')), cb);

    }

    function handleAll(request, response, cb) {
        var qs;

        if (request) {
            store.getAnswerList(request.question.map(function(q) {
                return {
                    name : q.name,
                    address : request.address,
                    type : ndns.consts.QTYPE_TO_NAME[q.type],
                    class : ndns.consts.QCLASS_TO_NAME[q.class]
                };
            }), function(err, zone) {
                // TODO clarify a.address vs a.data vs a.values
                if (err || !zone) {
                    return cb();
                }

                for (var i = 0; i < zone.length; i++) {
                    var a = zone[i];

                    var result = {
                        name : a.name,
                        address : a.data,
                        data : a.data,
                        exchange : a.exchange || a.data,
                        priority : a.priority || 10,
                        ttl : a.ttl || 600
                    };

                    // I think the TXT record requires an array
                    if ('TXT' === a.type && !Array.isArray(result.data)) {
                        result.data = [result.data];
                    }
                    response.answer.push(ndns[a.type](result));
                };

                cb();
            });
        } else {
            cb();
        }
    }

    function addNs(request, response, cb) {
        store.getNSList(function(err, nameservers) {
            nameservers.forEach(function(ns) {
                response.answer.push(ndns.NS({
                    name : request.question[0].name,
                    data : ns.name,
                    ttl : ns.ttl
                }));
                response.additional.push(ndns.A({
                    name : ns.name,
                    address : ns.data,
                    ttl : ns.ttl
                }));
            });

            cb();
        });
    }

    var handlers = {
        SOA : function(request, response, cb) {
            // See example of
            // dig soa google.com @ns1.google.com

            getSoa(request, function(err, soa) {
                if (err) {
                    return cb()
                }

                response.answer.push(ndns.SOA(soa));
                addNs(request, response, function() {
                    cb()
                });
            });

        },
        NAPTR : function(request, response, cb) {
            // See example of
            // dig naptr google.com @ns1.google.com
            getSoa(request, function(err, soa) {
                if (err) {
                    return cb()
                }
                response.authority.push(ndns.NAPTR({
                    "flags" : "aa qr rd"
                }));
                response.answer.push(ndns.SOA(soa));
                cb()
            });

        },
        NS : addNs,
        any : handleAll
    };

    return function(request, response) {
        //console.log(request, response)
        // although the standard defines the posibility of multiple queries,
        // in practice there is only one query per request
        var question = response.question[0];
        var wname = question && question.name || '';
        var lname = question && question.name.toLowerCase() || '';
        var typename = ndns.consts.QTYPE_TO_NAME[question && question.type];
        if (question) {
            question.name = lname;
        }

        // This is THE authority
        response.header.aa = 1;

        if (!handlers[typename]) {
            typename = 'any';
        }

        handlers[typename](request, response, function() {
            var opt;
            var opt2;

            if (request.additional.some(function(q) {
                // ndns.consts.NAME_TO_QTYPE.OPT // 41
                if (ndns.consts.NAME_TO_QTYPE.OPT === q.type) {
                    if (opt) {
                        opt2 = q;
                    }
                    opt = q;
                }
                return q;
            }).length > 0) {
                response.header.rcode = ndns.consts.NAME_TO_RCODE.NOERROR;
                // No Error

                if (0 !== opt.version) {
                    response.header.rcode = ndns.consts.NAME_TO_RCODE.BADVERS;
                    // Bad Version
                }

                if (opt2) {
                    response.header.rcode = ndns.consts.NAME_TO_RCODE.FORMERR;
                    // Format Error
                }

                response.edns_version = 0;
            }

            // Because WWw.ExaMPLe.coM increases security...
            // https://github.com/letsencrypt/boulder/issues/1228
            // https://github.com/letsencrypt/boulder/issues/1243
            ['answer', 'additional', 'authority'].forEach(function(atype) {
                response[atype].forEach(function(a) {
                    if (a.name) {
                        a.name = a.name.replace(lname, wname);
                    }
                });
            });

            return response.send();
            if (response.answer.length == 0) {
                return response.send();
                return getSoa(request, function(err, soa) {
                    if (err) {
                        return response.send();
                    }
                    response.answer.push(ndns.SOA(soa));
                    ['answer', 'additional', 'authority'].forEach(function(atype) {
                        response[atype].forEach(function(a) {
                            if (a.name) {
                                a.name = a.name.replace(lname, wname);
                            }
                        });
                    });

                    response.send();
                });

            }

        });
    };
};
