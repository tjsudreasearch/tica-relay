const { handleRequest } = require("../server");

module.exports = async (req, res) => {
  await handleRequest(req, res);
};
