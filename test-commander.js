const { Command } = require("commander"); const program = new Command(); program.option("--no-git", "test"); program.parse(); console.log("git option:", program.opts().git);
