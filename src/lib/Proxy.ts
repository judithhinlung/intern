import { getShouldWait, pullFromArray } from './util';
import { normalizePath } from './node/util';
import { instrument } from './instrument';
import * as aspect from 'dojo-core/aspect';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { lookup } from 'mime-types';
import * as net from 'net';
import { mixin } from 'dojo-core/lang';
import { Handle } from 'dojo-interfaces/core';

export interface ProxyProperties {
	basePath: string;
	excludeInstrumentation: boolean | RegExp;
	instrument: boolean;
	instrumenterOptions: any;
	port: number;
	waitForRunner: boolean;
};

export type ProxyOptions = Partial<ProxyProperties>;

export default class Proxy implements ProxyProperties {
	basePath: string;

	excludeInstrumentation: boolean | RegExp;

	instrument: boolean;

	instrumenterOptions: any;

	port: number;

	server: http.Server;

	waitForRunner: boolean;

	private _codeCache: { [filename: string]: { mtime: number, data: string } };

	private _sessions: { [id: string]: { lastSequence: number, queue: any, listeners: any[] } };

	constructor(options: ProxyOptions = {}) {
		mixin(this, options);
	}

	start() {
		return new Promise((resolve) => {
			const server = this.server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
				return this._handler(request, response);
			});
			this._sessions = {};
			this._codeCache = {};

			const sockets: net.Socket[] = [];

			// If sockets are not manually destroyed then Node.js will keep itself running until they all expire
			aspect.after(server, 'close', function () {
				let socket: net.Socket;
				while ((socket = sockets.pop())) {
					socket.destroy();
				}
			});

			server.on('connection', function (socket) {
				sockets.push(socket);

				// Disabling Nagle improves server performance on low-latency connections, which are more common
				// during testing than high-latency connections
				socket.setNoDelay(true);

				socket.on('close', function () {
					let index = sockets.indexOf(socket);
					index !== -1 && sockets.splice(index, 1);
				});
			});

			server.listen(this.port, resolve);
		});
	}

	stop() {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(resolve);
			}
			else {
				resolve();
			}

			this.server = this._codeCache = null;
		});
	}

	/**
	 * Listen for all events for a specific session
	 */
	subscribe(sessionId: string, listener: Function): Handle {
		const listeners = this._getSession(sessionId).listeners;
		listeners.push(listener);
		return {
			destroy: function (this: any) {
				this.destroy = function () {};
				pullFromArray(listeners, listener);
			}
		};
	}

	private _getSession(sessionId: string) {
		let session = this._sessions[sessionId];
		if (!session) {
			session = this._sessions[sessionId] = { lastSequence: -1, queue: {}, listeners: [] };
		}
		return session;
	}

	private _handler(request: http.IncomingMessage, response: http.ServerResponse) {
		if (request.method === 'GET') {
			if (/\.js(?:$|\?)/.test(request.url)) {
				this._handleFile(request, response, this.instrument);
			}
			else {
				this._handleFile(request, response);
			}
		}
		else if (request.method === 'HEAD') {
			this._handleFile(request, response, false, true);
		}
		else if (request.method === 'POST') {
			request.setEncoding('utf8');

			let data = '';
			request.on('data', function (chunk) {
				data += chunk;
			});

			request.on('end', () => {
				try {
					const messages: Message[] = JSON.parse(data).map(function (messageString: string) {
						return JSON.parse(messageString);
					});

					const runnerReporterPromise = Promise.all(messages.map((message) => {
						return this._publishInSequence(message);
					}));

					let shouldWait = messages.some((message) => {
						return getShouldWait(this.waitForRunner, message.payload);
					});

					if (shouldWait) {
						runnerReporterPromise.then(
							function () {
								response.statusCode = 204;
								response.end();
							},
							function () {
								response.statusCode = 500;
								response.end();
							}
						);
					}
					else {
						response.statusCode = 204;
						response.end();
					}
				}
				catch (error) {
					response.statusCode = 500;
					response.end();
				}
			});
		}
		else {
			response.statusCode = 501;
			response.end();
		}
	}

	private _handleFile(request: http.IncomingMessage, response: http.ServerResponse, shouldInstrument?: boolean, omitContent?: boolean) {
		function send(contentType: string, data: string) {
			response.writeHead(200, {
				'Content-Type': contentType,
				'Content-Length': Buffer.byteLength(data)
			});
			response.end(data);
		}

		const file = /^\/+([^?]*)/.exec(request.url)[1];
		let wholePath: string;

		if (/^__intern\//.test(file)) {
			const basePath = path.resolve(path.join(__dirname, '..'));
			wholePath = path.join(basePath, file.replace(/^__intern\//, ''));
			shouldInstrument = false;
		}
		else {
			wholePath = path.join(this.basePath, file);
		}

		wholePath = normalizePath(wholePath);

		if (wholePath.charAt(wholePath.length - 1) === '/') {
			wholePath += 'index.html';
		}

		// if the string passed to `excludeInstrumentation` changes here, it must also change in
		// `lib/executors/Executor.js`
		if (
			this.excludeInstrumentation === true ||
			(this.excludeInstrumentation && this.excludeInstrumentation.test(file))
		) {
			shouldInstrument = false;
		}

		const contentType = lookup(path.basename(wholePath)) || 'application/octet-stream';
		fs.stat(wholePath, (error, stats) => {
			// The proxy server was stopped before this file was served
			if (!this.server) {
				return;
			}

			if (error) {
				this._send404(response);
				return;
			}

			if (shouldInstrument) {
				const mtime = stats.mtime.getTime();
				if (this._codeCache[wholePath] && this._codeCache[wholePath].mtime === mtime) {
					send(contentType, this._codeCache[wholePath].data);
				}
				else {
					fs.readFile(wholePath, 'utf8', (error, data) => {
						// The proxy server was stopped in the middle of the file read
						if (!this.server) {
							return;
						}

						if (error) {
							this._send404(response);
							return;
						}

						// providing `wholePath` to the instrumenter instead of a partial filename is necessary because
						// lcov.info requires full path names as per the lcov spec
						data = instrument(
							data,
							wholePath,
							this.instrumenterOptions
						);
						this._codeCache[wholePath] = {
							// strictly speaking mtime could reflect a previous version, assume those race conditions are rare
							mtime: mtime,
							data: data
						};
						send(contentType, data);
					});
				}
			}
			else {
				response.writeHead(200, {
					'Content-Type': contentType,
					'Content-Length': stats.size
				});

				if (omitContent) {
					response.end();
				}
				else {
					fs.createReadStream(wholePath).pipe(response);
				}
			}
		});
	}

	private _publishInSequence(message: Message) {
		const session = this._getSession(message.sessionId);

		if (message.sequence <= session.lastSequence) {
			throw new Error('Repeated sequence for session ' + message.sessionId + ': ' + session.lastSequence +
				' last ' + message.sequence + ' cur');
		}

		message.promise = new Promise(resolve => {
			message.resolve = resolve;
		});

		if (message.sequence > session.lastSequence + 1) {
			session.queue[message.sequence] = message;
			return message.promise;
		}

		let triggerMessage = message;

		do {
			session.lastSequence = message.sequence;
			delete session.queue[session.lastSequence];

			if (!message.cancelled) {
				message.resolve(Promise.all(session.listeners.map(function (listener) {
					return listener.apply(null, message.payload);
				})));
			}
		}
		while ((message = session.queue[message.sequence + 1]));

		return triggerMessage.promise;
	}

	private _send404(response: http.ServerResponse) {
		response.writeHead(404, {
			'Content-Type': 'text/html;charset=utf-8'
		});
		response.end(`<!DOCTYPE html><title>404 Not Found</title><h1>404 Not Found</h1>` +
			`<!-- ${new Array(512).join('.')} -->`);
	}
}

interface Message {
	sessionId: string;
	sequence: number;
	cancelled: boolean;
	payload: string;
	promise: Promise<any>;
	resolve: (value?: any) => void;
}
