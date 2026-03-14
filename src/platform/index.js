const platform = process.platform === "win32"
  ? require("./win32")
  : require("./darwin");

module.exports = platform;
