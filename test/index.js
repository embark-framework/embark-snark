jest.mock('child_process');
jest.mock('find-up');
jest.mock('glob');
jest.mock('snarkjs');

const { exec } = require('child_process');

const findUp = require('find-up');
const path = require('path');
const somePath = path.normalize('/some/path');
findUp.sync.mockImplementation(() => somePath);

const glob = require('glob');

const snarkjs = require('snarkjs');
const someString = 'someString';
snarkjs.bigInt = class {
  toString() {
    return someString;
  }
};

describe('embark-snark', () => {
  let Snarks, plugin;

  describe('side effects', () => {
    describe('bigInt patching', () => {
      it("should patch the prototype of snarkjs' bigInt constructor with a toJSON method", () => {
        expect(snarkjs.bigInt.prototype.toJSON).toBeUndefined();
        ({ Snarks, default: plugin } = require('../src/index.js'));
        expect(new snarkjs.bigInt().toJSON()).toBe(someString);
      });
    });
  });

  describe('plugin', () => {
    let dappPath, embark;

    beforeAll(() => {
      dappPath = jest.fn(() => {});
      embark = { config: { dappPath } };
    });

    it('should call the implementation (Snarks class) with its argument', () => {
      plugin(embark);
      expect(dappPath).toHaveBeenCalled();
    });
  });

  describe('Snarks class', () => {
    describe('static properties', () => {
      it('should have the expected static properties', () => {
        expect(Snarks.circomBinary).toBe(somePath);
        expect(Snarks.snarkjsBinary).toBe(somePath);
      });
    });

    describe('constructor', () => {
      let dappPath, fs, logger, pluginConfig, embark, embarkNoPluginConfig;

      beforeAll(() => {
        dappPath = jest.fn(() => somePath);
        fs = {};
        logger = {};
        pluginConfig = {};

        embark = {
          config: { dappPath },
          fs,
          logger,
          pluginConfig
        };

        embarkNoPluginConfig = {
          config: { dappPath },
          fs,
          logger
        };

        jest.spyOn(Snarks.prototype, 'registerEvents');
        Snarks.prototype.registerEvents.mockImplementation(() => {});
      });

      afterAll(() => {
        Snarks.prototype.registerEvents.mockRestore();
      });

      it('should setup the expected instance properties', () => {
        const snarks = new Snarks(embark);
        expect(snarks.embark).toBe(embark);
        expect(snarks.circuitsConfig).toBe(pluginConfig);
        expect(snarks.compiledCircuitsPath).toBe(somePath);
        expect(snarks.fs).toBe(fs);
        expect(snarks.logger).toBe(logger);
      });

      it('should call Snarks#registerEvents only when there is a plugin config', () => {
        let snarks = new Snarks(embark);
        expect(snarks.registerEvents).toHaveBeenCalled();

        Snarks.prototype.registerEvents.mockClear();

        snarks = new Snarks(embarkNoPluginConfig);
        expect(snarks.registerEvents).not.toHaveBeenCalled();
      });
    });

    describe('instance methods', () => {
      let errorLogger, infoLogger, snarks;

      beforeAll(() => {
        errorLogger = jest.fn(() => {});
        infoLogger = jest.fn(() => {});
      });

      beforeEach(() => {
        snarks = Object.create(Snarks.prototype);
        snarks.compiledCircuitsPath = somePath;
        snarks.logger = { error: errorLogger, info: infoLogger };
      });

      describe('registerEvents', () => {
        let bind, bound, registerActionForEvent;

        beforeAll(() => {
          bound = () => {};
          bind = jest.fn(() => bound);

          registerActionForEvent = jest.fn(() => {});
        });

        beforeEach(() => {
          snarks.compileAndGenerateContracts = { bind };
          snarks.embark = { registerActionForEvent };
        });

        it("should call embark's registerActionForEvent with instance-bound Snarks#compileAndGenerateContracts", () => {
          snarks.registerEvents();
          expect(registerActionForEvent).toHaveBeenCalledWith(
            expect.any(String),
            bound
          );
          expect(bind).toHaveBeenCalledWith(snarks);
        });
      });

      describe('verifierFilepath', () => {
        it('should combine a path, basename, and extension', () => {
          const basename = 'foo';

          const combined = snarks.verifierFilepath(basename);
          expect(combined).toBe(
            path.join(somePath, `${basename}${Snarks.Extensions.VkVerifier}`)
          );
        });
      });

      describe('verifierContractPath', () => {
        it('should combine a path, basename, and extension', () => {
          const basename = 'foo';

          const combined = snarks.verifierContractPath(basename);
          expect(combined).toBe(
            path.join(somePath, `${basename}${Snarks.Extensions.Solidity}`)
          );
        });
      });

      describe('proofFilepath', () => {
        it('should combine a path, basename, and extension', () => {
          const basename = 'foo';

          const combined = snarks.proofFilepath(basename);
          expect(combined).toBe(
            path.join(somePath, `${basename}${Snarks.Extensions.VkProof}`)
          );
        });
      });

      describe('compileCircuits', () => {
        let bar, foo, ensureDir;

        beforeAll(() => {
          foo = `foo${Snarks.Extensions.Circom}`;
          bar = `bar${Snarks.Extensions.Circom}`;
          ensureDir = jest.fn(() => {});

          glob.mockImplementation((_, cb) =>
            cb(null, [foo, 'A.aaa', bar, 'B.bbb'])
          );
        });

        beforeEach(() => {
          snarks.compileCircuit = jest.fn(() => {});
          snarks.fs = { ensureDir };
        });

        afterAll(() => {
          glob.mockReset();
        });

        it('should not compile if no matching circuits are found', async () => {
          const circuits = [];
          snarks.circuitsConfig = { circuits };

          await snarks.compileCircuits();
          expect(snarks.compileCircuit).not.toHaveBeenCalled();
        });

        it('should compile the configured circuits', async () => {
          const circuits = ['whatever'];
          snarks.circuitsConfig = { circuits };

          await snarks.compileCircuits();
          expect(snarks.compileCircuit).toHaveBeenNthCalledWith(1, foo);
          expect(snarks.compileCircuit).toHaveBeenNthCalledWith(2, bar);
          expect(snarks.compileCircuit).toHaveBeenCalledTimes(2);
        });
      });

      describe('compileCircuit', () => {
        let basename, filepath;

        beforeAll(() => {
          basename = 'foo';
          filepath = path.join(
            somePath,
            `${basename}${Snarks.Extensions.Circom}`
          );
        });

        afterEach(() => {
          exec.mockReset();
        });

        it('should compile the ciruict', async () => {
          exec.mockImplementation((_, cb) => cb());

          await snarks.compileCircuit(filepath);
          expect(exec).toHaveBeenCalledWith(
            expect.stringContaining(filepath),
            expect.any(Function)
          );
          expect(exec).toHaveBeenCalledWith(
            expect.stringContaining(
              path.join(somePath, `${basename}${Snarks.Extensions.Json}`)
            ),
            expect.any(Function)
          );
        });

        it('should reject if the compiler has an error', async () => {
          const message = 'error';
          exec.mockImplementation((_, cb) => cb(new Error(message)));

          await expect(snarks.compileCircuit(filepath)).rejects.toThrow(
            message
          );
        });
      });

      describe('generateProofs', () => {
        let bar, foo, readdir;

        beforeAll(() => {
          foo = `foo${Snarks.Extensions.Json}`;
          bar = `bar${Snarks.Extensions.Json}`;
          readdir = jest.fn(async () => [foo, 'A.aaa', bar, 'B.bbb']);
        });

        beforeEach(() => {
          snarks.generateProof = jest.fn(() => {});
          snarks.fs = { readdir };
        });

        it('generate proofs for the compiled circuits', async () => {
          await snarks.generateProofs();
          expect(snarks.generateProof).toHaveBeenNthCalledWith(1, foo);
          expect(snarks.generateProof).toHaveBeenNthCalledWith(2, bar);
          expect(snarks.generateProof).toHaveBeenCalledTimes(2);
        });
      });

      describe('generateProof', () => {
        let basename,
          calculateWitness,
          filename,
          foo,
          inputs,
          proof,
          publicSignals,
          setup,
          vk_verifier;

        beforeAll(() => {
          basename = 'foo';
          calculateWitness = jest.fn(() => {});
          filename = `${basename}${Snarks.Extensions.Json}`;
          foo = {};
          inputs = { foo };
          proof = {};
          publicSignals = {};

          vk_verifier = {};
          setup = { vk_verifier };

          snarkjs.original.genProof.mockImplementation(() => ({
            proof,
            publicSignals
          }));
        });

        beforeEach(() => {
          snarks.circuitsConfig = { inputs };
          snarks.getCircuit = jest.fn(() => ({ calculateWitness }));
          snarks.generateSetup = jest.fn(() => setup);
          snarks.generateVerifier = jest.fn(() => {});
        });

        afterEach(() => {
          snarkjs.original.isValid.mockReset();
        });

        afterAll(() => {
          snarkjs.original.genProof.mockReset();
        });

        it('should not generate if there is no matching input', async () => {
          snarks.circuitsConfig = { inputs: {} };

          await snarks.generateProof(filename);
          expect(snarkjs.original.isValid).not.toHaveBeenCalled();
        });

        it('generate the proof for a circuit', async () => {
          snarkjs.original.isValid.mockImplementation(() => true);

          await snarks.generateProof(filename);
          expect(snarkjs.original.isValid).toHaveBeenCalledWith(
            vk_verifier,
            proof,
            publicSignals
          );
          expect(snarks.generateVerifier).toHaveBeenCalledWith(
            path.basename(filename, Snarks.Extensions.Json)
          );
        });

        it('should reject if the proof is not valid', async () => {
          snarkjs.original.isValid.mockImplementation(() => false);

          await expect(snarks.generateProof(filename)).rejects.toThrow(
            /^The proof is not valid/
          );
          expect(snarks.generateVerifier).not.toHaveBeenCalled();
        });
      });

      describe('getCircuit', () => {
        let circuit, filepath, readFile;

        beforeAll(() => {
          circuit = {};
          filepath = 'whatever';
          readFile = jest.fn(async () => '{}');

          snarkjs.Circuit.mockImplementation(function() {
            return circuit;
          });
        });

        beforeEach(() => {
          snarks.fs = { readFile };
        });

        afterAll(() => {
          snarkjs.Circuit.mockReset();
        });

        it("returns a circuit object given a compiled-circuit's path", async () => {
          await expect(snarks.getCircuit(filepath)).resolves.toBe(circuit);
        });
      });

      describe('generateSetup', () => {
        let basename,
          circuit,
          filepath,
          setup,
          vk_proof,
          vk_verifier,
          writeFile;

        beforeAll(() => {
          basename = 'foo';
          circuit = {};
          filepath = path.join(somePath, basename);

          vk_proof = {};
          vk_verifier = {};
          setup = { vk_proof, vk_verifier };

          writeFile = jest.fn(async () => {});

          snarkjs.original.setup.mockImplementation(() => setup);
        });

        beforeEach(() => {
          snarks.fs = { writeFile };
          snarks.proofFilepath = jest.fn(() => filepath);
          snarks.verifierFilepath = jest.fn(() => filepath);
        });

        afterAll(() => {
          snarkjs.original.setup.mockReset();
        });

        it('should write proof and verifier files for a circuit', async () => {
          await snarks.generateSetup(circuit, basename);
          expect(writeFile).toHaveBeenNthCalledWith(1, filepath, '{}', 'utf8');
          expect(writeFile).toHaveBeenNthCalledWith(2, filepath, '{}', 'utf8');
          expect(writeFile).toHaveBeenCalledTimes(2);
        });

        it('should return the snarkjs setup', async () => {
          await expect(snarks.generateSetup(circuit, basename)).resolves.toBe(
            setup
          );
        });
      });

      describe('generateVerifier', () => {
        let basename, contractPath, vkVerifierPath;

        beforeAll(() => {
          basename = 'foo';
          contractPath = path.join(
            somePath,
            `${basename}${Snarks.Extensions.Solidity}`
          );
          vkVerifierPath = contractPath = path.join(
            somePath,
            `${basename}${Snarks.Extensions.VkVerifier}`
          );
        });

        beforeEach(() => {
          snarks.verifierFilepath = jest.fn(() => vkVerifierPath);
          snarks.verifierContractPath = jest.fn(() => contractPath);
        });

        afterEach(() => {
          exec.mockReset();
        });

        it('should generate the verifier-contracts', async () => {
          exec.mockImplementation((_, cb) => cb());

          await snarks.generateVerifier(basename);
          expect(exec).toHaveBeenCalledWith(
            expect.stringContaining(vkVerifierPath),
            expect.any(Function)
          );
          expect(exec).toHaveBeenCalledWith(
            expect.stringContaining(contractPath),
            expect.any(Function)
          );
        });

        it('should reject if there is an error during generation', async () => {
          const message = 'error';
          exec.mockImplementation((_, cb) => cb(new Error(message)));

          await expect(snarks.generateVerifier(basename)).rejects.toThrow(
            message
          );
        });
      });

      describe('addVerifiersToContracts', () => {
        let bar, foo, readdir;

        beforeAll(() => {
          foo = `foo${Snarks.Extensions.Solidity}`;
          bar = `bar${Snarks.Extensions.Solidity}`;
          readdir = jest.fn(async () => [foo, 'A.aaa', bar, 'B.bbb']);
        });

        beforeEach(() => {
          snarks.addVerifierToContracts = jest.fn(() => {});
          snarks.fs = { readdir };
        });

        it('should add all verifier-contracts', async () => {
          await snarks.addVerifiersToContracts();
          expect(snarks.addVerifierToContracts).toHaveBeenNthCalledWith(1, foo);
          expect(snarks.addVerifierToContracts).toHaveBeenNthCalledWith(2, bar);
          expect(snarks.addVerifierToContracts).toHaveBeenCalledTimes(2);
        });
      });

      describe('addVerifierToContracts', () => {
        let events, filename, filepath, request;

        beforeAll(() => {
          request = jest.fn(() => {});
          events = { request };
          filename = 'whatever';
          filepath = path.join(somePath, filename);
        });

        beforeEach(() => {
          snarks.embark = { events };
        });

        it("should request embark to add a verifier-contract to the DApp project's contracts", () => {
          snarks.addVerifierToContracts(filename);
          expect(request).toHaveBeenCalledWith(expect.any(String), filepath);
        });
      });

      describe('compileAndGenerateContracts', () => {
        let callback, error;

        beforeAll(() => {
          callback = jest.fn(() => {});
          error = new Error('error');
        });

        beforeEach(() => {
          snarks.compileCircuits = jest.fn(() => {});
          snarks.generateProofs = jest.fn(() => {});
          snarks.addVerifiersToContracts = jest.fn(() => {});
        });

        it('should call back without error after successfully compiling and generating', async () => {
          await snarks.compileAndGenerateContracts(callback);
          expect(callback).toHaveBeenCalledWith();
        });

        it('should call back with an error if a step fails', async () => {
          snarks.generateProofs = jest.fn(() => {
            throw error;
          });

          await snarks.compileAndGenerateContracts(callback);
          expect(callback).toHaveBeenCalledWith(error);

          error = new Error();

          await snarks.compileAndGenerateContracts(callback);
          expect(callback).toHaveBeenCalledWith(error);
        });
      });
    });
  });
});
