import { exec } from 'child_process';
import { sync as findUp } from 'find-up';
import * as fs from 'fs-extra';
import globCb from 'glob';
import * as path from 'path';
import semver from 'semver';
import * as zkSnark from 'snarkjs';
import { promisify } from 'util';

const glob = promisify(globCb);

zkSnark.bigInt.prototype.toJSON = function() {
  return this.toString();
};

const Extension = {
  Json: '.json',
  Circom: '.circom',
  VkProof: '.vk_proof',
  VkVerifier: '.vk_verifier',
  Solidity: '.sol'
};

class Snarks {
  constructor(embark) {
    this.embark = embark;
    this.circuitsConfig = embark.pluginConfig;
    this.compiledCircuitsPath = embark.config.dappPath('.embark', 'snarks');
    // v5 detection won't work as desired with "dev embark" (built in monorepo)
    // until after first prerelease of embark v5; can assign `true` to test
    // this.isEmbark5 = true;
    this.isEmbark5 = semver(this.embark.version).major >= 5;
    this.registerEvents();
  }

  static circomBinary = findUp('node_modules/.bin/circom', { cwd: __dirname });
  static snarkjsBinary = findUp('node_modules/.bin/snarkjs', {
    cwd: __dirname
  });

  registerEvents() {
    if (this.isEmbark5) {
      return this.embark.registerActionForEvent(
        'compiler:contracts:compile:before',
        (contractFiles, callback) => {
          this.compileAndGenerateContracts(contractFiles, callback);
        }
      );
    }
    this.embark.registerActionForEvent('build:beforeAll', callback =>
      this.compileAndGenerateContracts([], callback)
    );
  }

  verifierFilepath(basename) {
    return path.join(
      this.compiledCircuitsPath,
      `${basename}${Extension.VkVerifier}`
    );
  }

  verifierContractPath(basename) {
    return path.join(
      this.compiledCircuitsPath,
      `${basename}${Extension.Solidity}`
    );
  }

  proofFilepath(basename) {
    return path.join(
      this.compiledCircuitsPath,
      `${basename}${Extension.VkProof}`
    );
  }

  async compileCircuits() {
    await fs.ensureDir(this.compiledCircuitsPath);

    const patterns = this.circuitsConfig.circuits;
    if (!patterns) {
      return;
    }

    this.embark.logger.info('Compiling circuits...');

    await Promise.all(
      patterns.map(async pattern => {
        const filepaths = await glob(pattern);
        await Promise.all(
          filepaths
            .filter(filename => path.extname(filename) === Extension.Circom)
            .map(filepath => this.compileCircuit(filepath))
        );
      })
    );
  }

  compileCircuit(filepath) {
    return new Promise((resolve, reject) => {
      const output = path.join(
        this.compiledCircuitsPath,
        `${path.basename(filepath, Extension.Circom)}${Extension.Json}`
      );
      exec(`${Snarks.circomBinary} ${filepath} -o ${output}`, error => {
        if (error) {
          return reject(error);
        }

        resolve();
      });
    });
  }

  async generateProofs() {
    this.embark.logger.info('Generating proofs...');

    await Promise.all(
      (await fs.readdir(this.compiledCircuitsPath))
        .filter(filename => path.extname(filename) === Extension.Json)
        .map(filename => this.generateProof(filename))
    );
  }

  async generateProof(filename) {
    const filepath = path.join(this.compiledCircuitsPath, filename);
    const basename = path.basename(filename, Extension.Json);

    const circuit = await this.getCircuit(filepath);
    const setup = await this.generateSetup(circuit, basename);

    const input = this.circuitsConfig.inputs[basename];
    if (!input) {
      return;
    }

    const witness = circuit.calculateWitness(input);
    const { proof, publicSignals } = zkSnark.original.genProof(
      setup.vk_proof,
      witness
    );
    if (!zkSnark.original.isValid(setup.vk_verifier, proof, publicSignals)) {
      throw new Error(
        `The proof is not valid for ${basename} with inputs: ${JSON.stringify(
          input
        )}`
      );
    }

    return this.generateVerifier(basename);
  }

  async getCircuit(filepath) {
    const definition = JSON.parse(await fs.readFile(filepath, 'utf8'));
    return new zkSnark.Circuit(definition);
  }

  async generateSetup(circuit, basename) {
    const setup = zkSnark.original.setup(circuit);
    await Promise.all([
      fs.writeFile(
        this.proofFilepath(basename),
        JSON.stringify(setup.vk_proof),
        'utf8'
      ),
      fs.writeFile(
        this.verifierFilepath(basename),
        JSON.stringify(setup.vk_verifier),
        'utf8'
      )
    ]);

    return setup;
  }

  generateVerifier(basename) {
    return new Promise((resolve, reject) => {
      const source = this.verifierFilepath(basename);
      const output = this.verifierContractPath(basename);
      exec(
        `${Snarks.snarkjsBinary} generateverifier --vk ${source} -v ${output}`,
        error => {
          if (error) {
            return reject(error);
          }

          resolve();
        }
      );
    });
  }

  async addVerifiersToContracts(contractFiles) {
    (await fs.readdir(this.compiledCircuitsPath))
      .filter(filename => path.extname(filename) === Extension.Solidity)
      .map(filename => this.addVerifierToContracts(filename, contractFiles));
  }

  addVerifierToContracts(filename, contractFiles) {
    filename = path.join(this.compiledCircuitsPath, filename);
    if (this.isEmbark5) {
      return contractFiles.push({ path: filename });
    }
    this.embark.events.request('config:contractsFiles:add', filename);
  }

  async compileAndGenerateContracts(contractFiles, callback) {
    try {
      await this.compileCircuits();
      await this.generateProofs();
      await this.addVerifiersToContracts(contractFiles);
    } catch (error) {
      this.embark.logger.error(error.message || error);
    }
    if (this.isEmbark5) {
      callback(null, contractFiles);
    } else {
      callback();
    }
  }
}

export default embark => {
  if (embark.pluginConfig) new Snarks(embark);
};
