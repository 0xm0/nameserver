/*
 At your option you may choose either of the following licenses:

 * The MIT License (MIT)
 * The Apache License 2.0 (Apache-2.0)

 The MIT License (MIT)

 Copyright (c) 2015 AJ ONeal

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
 */

var ndns = require('native-dns');
var tld = require('tldjs');

'use strict';

module.exports.create = function(store) {

	// TODO move promise to dependencies
	var PromiseA = require('bluebird');

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
			qs = request.question.map(function(q) {
				// TODO give the bits is well (for convenience)
				return {
					name : q.name,
					type : ndns.consts.QTYPE_TO_NAME[q.type],
					class : ndns.consts.QCLASS_TO_NAME[q.class]
				};
				// TODO promise?
			});
		}

		store.getAnswerList(qs, function(err, zone) {
			// TODO clarify a.address vs a.data vs a.values
			if (err) {
				throw err;
			}

			var names = [];
			var patterns = [];
			var matchesMap = {};
			var matches = [];

			function pushMatch(a) {
				var id = a.name + ':' + a.type + ':' + a.value;
				if (!matchesMap[id]) {
					matchesMap[id] = true;
					matches.push(a);
				}
			}

			// TODO ANAME for when we want to use a CNAME with a root (such as 'example.com')
			zone.forEach(function(a) {
				if ('*' === a.name[0] && '.' === a.name[1]) {
					// *.example.com => .example.com (valid)
					// *example.com => example.com (invalid, but still safe)
					// TODO clone a
					a.name = a.name.slice(1);
				}

				if ('.' === a.name[0]) {
					patterns.push(a);
				} else {
					names.push(a);
				}
			});

			function byDomainLen(a, b) {
				// sort most to least explicit
				// .www.example.com
				// www.example.com
				// a.example.com
				return (b.name || b.zone).length - (a.name || a.zone).length;
			}


			names.sort(byDomainLen);
			patterns.sort(byDomainLen);

			function testType(q, a) {
				var qtype = ndns.consts.QTYPE_TO_NAME[q.type];

				if (a.type === qtype) {
					pushMatch(a);
					return;
				}

				if (-1 !== ['A', 'AAAA'].indexOf(qtype)) {
					if ('ANAME' === a.type) {
						// TODO clone a
						a.realtype = qtype;
						pushMatch(a);
					} else if ('CNAME' === a.type) {
						pushMatch(a);
					}
				}

				if ('ANY' === qtype) {
					if ('ANAME' === a.type) {
						// TODO clone a
						a.realtype = 'A';
					}

					pushMatch(a);
				}
			}


			names.forEach(function(a) {
				request.question.forEach(function(q) {
					if (a.name !== q.name) {
						return;
					}

					testType(q, a);
				});
			});

			if (!matches.length) {
				patterns.forEach(function(a) {
					request.question.forEach(function(q) {
						var isWild;

						isWild = (a.name === q.name.slice(q.name.length - a.name.length))
						// should .example.com match example.com if none set?
						// (which would mean any ANAME must be a CNAME)
						//|| (a.name.slice(1) === q.name.slice(q.name.length - (a.name.length - 1)))
						;

						if (!isWild) {
							return;
						}

						// TODO clone a
						a.name = q.name;
						testType(q, a);
					});
				});
			}

			return PromiseA.all(matches.map(function(a) {
				if (a.value) {
					a.values = [a.value];
				}

				// TODO alias value as the appropriate thing?
				var result = {
					name : a.name,
					address : a.address || a.value,
					data : a.data || a.values,
					exchange : a.exchange || a.value,
					priority : a.priority || 10,
					ttl : a.ttl || 600
				};

				if ('CNAME' === a.type) {
					if (Array.isArray(result.data)) {
						result.data = result.data[0];
					}
					if (!result.data) {
						console.error('[CNAME ERROR]');
						console.error(result);
					}
				}
				// I think the TXT record requires an array
				if ('TXT' === a.type && !Array.isArray(result.data)) {
					result.data = [result.data];
				}

				return ndns[a.type](result);
			})).then(function(answers) {
				response.answer = response.answer.concat(answers.filter(function(a) {
					return a;
				}));

				cb();
			});
		});
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
					address : ns.address,
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
		NS : function(request, response, cb) {
			// See example of
			// dig ns google.com @ns1.google.com

			addNs(request, response, cb);

		},
		A : function(request, response, cb) {
			if (/^local(host)?\./.test(request.question[0].name)) {
				setLocalhost(request, response, '127.0.0.1');
				return cb();
			}

			handleAll(request, response, cb);

		},
		AAAA : function(request, response, cb) {
			if (/^local(host)?\./.test(request.question[0].name)) {
				setLocalhost(request, response, '::1');
				return cb();
			}

			handleAll(request, response, cb);
		},
		ANY : function handleAny(request, response, cb) {
			addNs(request, response, function() {
				handleAll(request, response, cb);
			});

		},
		CNAME : handleAll,
		MX : handleAll,
		SRV : handleAll,
		TXT : handleAll,
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
			})) {
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

			if (response.answer.length == 0) {
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

			response.send();
		});
	};
};
