const { createRequestHandler } = require('../server');

const handler = createRequestHandler();

module.exports = (req, res) => handler(req, res);
