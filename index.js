/*global require, module*/
const fs = require("fs-extra");
const exec = require("child_process").exec;
const globule = require("globule");
const path = require("path");
const zkSnark = require("snarkjs");

zkSnark.bigInt.prototype.toJSON = function() { return this.toString(); };
const circomBinary = path.join(__dirname, "./node_modules/.bin/circom");
const snarkjsBinary = path.join(__dirname, "./node_modules/.bin/snarkjs");

const Extension = {
  Json: ".json",
  Circom: ".circom",
  VkProof: ".vk_proof",
  VkVerifier: ".vk_verifier",
  Solidity: ".sol"
};

class Snarks {
  constructor(embark) {
    this.embark = embark;
    this.circuitsConfig = embark.pluginConfig;
    this.compiledCircuitsPath = path.join(this.embark.config.dappPath(), ".embark", "snarks");
    fs.ensureDirSync(this.compiledCircuitsPath);
  }

  verifierFilepath(basename) { 
    return path.join(this.compiledCircuitsPath, `${basename}${Extension.VkVerifier}`);
  }

  verifierContractPath(basename) {
    return path.join(this.compiledCircuitsPath, `${basename}${Extension.Solidity}`);
  }

  proofFilepath(basename) {
    return path.join(this.compiledCircuitsPath, `${basename}${Extension.VkProof}`);
  }

  compileCircuits() {
    const patterns = this.circuitsConfig.circuits;
    if (!patterns) {
      return [];
    }

    this.embark.logger.info("Compiling circuits...");
    return patterns.reduce((promises, pattern) => {
      const filepaths = globule.find(pattern);
      const newPromises = filepaths.filter((filename) => path.extname(filename) === Extension.Circom)
                                   .map((filepath) => this.compileCircuit(filepath));
      return promises.concat(newPromises);
    }, []);
  }

  compileCircuit(filepath) {
    return new Promise((resolve, reject) => {
      const output = path.join(this.compiledCircuitsPath, `${path.basename(filepath, Extension.Circom)}${Extension.Json}`);
      exec(`${circomBinary} ${filepath} -o ${output}`, (error) => {
        if (error) {
          return reject(error);
        }

        resolve();
      });
    });
  }

  generateProofs() {
    this.embark.logger.info("Generating proofs...");

    return fs.readdirSync(this.compiledCircuitsPath)
             .filter((filename) => path.extname(filename) === Extension.Json)
             .map((filename) => this.generateProof(filename));
  }

  generateProof(filename) {
    const filepath = path.join(this.compiledCircuitsPath, filename);
    const basename = path.basename(filename, Extension.Json);

    const circuit = this.getCircuit(filepath);
    const setup = this.generateSetup(circuit, basename);

    const input = this.circuitsConfig.inputs[basename];
    if (!input) {
      return new Promise((resolve) => resolve());
    }

    const witness = circuit.calculateWitness(input);
    const {proof, publicSignals} = zkSnark.original.genProof(setup.vk_proof, witness);
    if (zkSnark.original.isValid(setup.vk_verifier, proof, publicSignals)) {
      return this.generateVerifier(basename);
    }

    throw new Error(`The proof is not valid for ${basename} with inputs: ${JSON.stringify(input)}`);
  }

  getCircuit(filepath) {
    const definition = JSON.parse(fs.readFileSync(filepath, "utf8"));
    return new zkSnark.Circuit(definition);
  }

  generateSetup(circuit, basename) {
    const setup = zkSnark.original.setup(circuit);
    fs.writeFileSync(this.proofFilepath(basename), JSON.stringify(setup.vk_proof), "utf8");
    fs.writeFileSync(this.verifierFilepath(basename), JSON.stringify(setup.vk_verifier), "utf8");

    return setup;
  }

  generateVerifier(basename) {
    return new Promise((resolve, reject) => {
      const source = this.verifierFilepath(basename);
      const output = this.verifierContractPath(basename);
      exec(`${snarkjsBinary} generateverifier --vk ${source} -v ${output}`, (error) => {
        if (error) {
          return reject(error);
        }

        resolve();
      });
    });
  }
  
  addVerifiersToContracts() {
    fs.readdirSync(this.compiledCircuitsPath)
      .filter((filename) => path.extname(filename) === Extension.Solidity)
      .map((filename) => this.addVerifierToContracts(filename));
  }

  addVerifierToContracts(filename) {
    this.embark.events.request("config:contractsFiles:add", path.join(this.compiledCircuitsPath, filename));
  }

  async compileAndGenerateContracts(embark, callback) {
    try {
      await Promise.all(this.compileCircuits());
      await Promise.all(this.generateProofs());
      this.addVerifiersToContracts();
      callback();
    } catch (error) {
      embark.logger.error(error.message);
      callback();
    }
  }
}

module.exports = (embark) => {
  if (embark.pluginConfig) {
    const snarks = new Snarks(embark);
    embark.registerActionForEvent("build:beforeAll", (callback) => snarks.compileAndGenerateContracts(embark, callback));
  }
};
