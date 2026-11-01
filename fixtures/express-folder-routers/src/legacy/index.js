const fs = require("fs");
const path = require("path");

module.exports = function mountLegacy(app) {
  fs.readdirSync(__dirname)
    .filter((file) => file !== "index.js")
    .forEach((file) => {
      const name = path.basename(file, ".js");
      app.use(`/legacy/${name}`, require(path.join(__dirname, file)));
    });
};
