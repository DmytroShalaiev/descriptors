// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

//TODO set the witnessScript and the redeemScript to all the other types
//TODO: test p2sh, p2sh(p2wsh()), p2wpkh, ... without Ledger. Make integration test
//TODO: test calling from typescript to make sure all relevant types are
//exported

import {
  address,
  networks,
  payments,
  script as bscript,
  Network,
  Payment,
  Transaction,
  PsbtTxInput,
  Psbt
} from 'bitcoinjs-lib';
import type {
  PsbtInput,
  Bip32Derivation,
  PartialSig
} from 'bip174/src/lib/interfaces';
const { p2sh, p2wpkh, p2pkh, p2pk, p2wsh, p2tr } = payments;
import { BIP32Factory, BIP32API } from 'bip32';
import { ECPairFactory, ECPairAPI } from 'ecpair';

import type {
  TinySecp256k1Interface,
  Preimage,
  TimeConstraints,
  ExpansionMap,
  KeyInfo,
  ParseKeyExpression
} from './types';

import { finalScriptsFuncFactory } from './psbt';
import { DescriptorChecksum } from './checksum';
import { parseKeyExpression as globalParseKeyExpression } from './keyExpressions';
import * as RE from './re';
import {
  expandMiniscript as globalExpandMiniscript,
  miniscript2Script,
  satisfyMiniscript
} from './miniscript';

interface PsbtInputExtended extends PsbtInput, PsbtTxInput {}

//See "Resource limitations" https://bitcoin.sipa.be/miniscript/
//https://lists.linuxfoundation.org/pipermail/bitcoin-dev/2019-September/017306.html
const MAX_SCRIPT_ELEMENT_SIZE = 520;
const MAX_STANDARD_P2WSH_SCRIPT_SIZE = 3600;
const MAX_OPS_PER_SCRIPT = 201;

function countNonPushOnlyOPs(script: Buffer): number {
  const decompile = bscript.decompile(script);
  if (!decompile) throw new Error(`Error: cound not decompile ${script}`);
  return decompile.filter(op => op > bscript.OPS['OP_16']!).length;
}

/*
 * Returns a bare descriptor without checksum and particularized for a certain
 * index (if desc was a range descriptor)
 */
function evaluate({
  expression,
  checksumRequired,
  index
}: {
  expression: string;
  checksumRequired: boolean;
  index?: number;
}): string {
  const mChecksum = expression.match(String.raw`(${RE.reChecksum})$`);
  if (mChecksum === null && checksumRequired === true)
    throw new Error(`Error: descriptor ${expression} has not checksum`);
  //evaluatedExpression: a bare desc without checksum and particularized for a certain
  //index (if desc was a range descriptor)
  let evaluatedExpression = expression;
  if (mChecksum !== null) {
    const checksum = mChecksum[0].substring(1); //remove the leading #
    evaluatedExpression = expression.substring(
      0,
      expression.length - mChecksum[0].length
    );
    if (checksum !== DescriptorChecksum(evaluatedExpression)) {
      throw new Error(`Error: invalid descriptor checksum for ${expression}`);
    }
  }
  let mWildcard = evaluatedExpression.match(/\*/g);
  if (mWildcard && mWildcard.length > 0) {
    if (index === undefined)
      throw new Error(`Error: index was not provided for ranged descriptor`);
    if (!Number.isInteger(index) || index < 0)
      throw new Error(`Error: invalid index ${index}`);
    //From  https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md
    //To prevent a combinatorial explosion of the search space, if more than
    //one of the multi() key arguments is a BIP32 wildcard path ending in /* or
    //*', the multi() expression only matches multisig scripts with the ith
    //child key from each wildcard path in lockstep, rather than scripts with
    //any combination of child keys from each wildcard path.

    //We extend this reasoning for musig for all cases
    evaluatedExpression = evaluatedExpression.replaceAll('*', index.toString());
  }
  return evaluatedExpression;
}

//TODO: Do a proper declaration interface DescriptorInterface or API...
export interface DescriptorInterface {
  //getPayment(): any;
  //getAddress(): string;
  //getScriptPubKey(): any;
  //getScriptSatisfaction(signatures: any[]): Buffer;
  // ... add the rest of the methods and properties as required
}

/**
 * Builds the functions needed to operate with descriptors using an external elliptic curve (ecc) library.
 * @param {Object} ecc - an object containing elliptic curve operations, such as [tiny-secp256k1](https://github.com/bitcoinjs/tiny-secp256k1) or [@bitcoinerlab/secp256k1](https://github.com/bitcoinerlab/secp256k1).
 * @returns {Object} an object containing functions, `parse` and `checksum`.
 * @namespace
 */
export function DescriptorsFactory(ecc: TinySecp256k1Interface): {
  Descriptor: DescriptorInterface;
  ECPair: ECPairAPI;
  parseKeyExpression: ParseKeyExpression;
  BIP32: BIP32API;
} {
  const BIP32: BIP32API = BIP32Factory(ecc);
  const ECPair: ECPairAPI = ECPairFactory(ecc);

  /*
   * Takes a string key expression (xpub, xprv, pubkey or wif) and parses it
   */
  const parseKeyExpression: ParseKeyExpression = ({
    keyExpression,
    isSegwit,
    network = networks.bitcoin
  }) => {
    return globalParseKeyExpression({
      keyExpression,
      network,
      isSegwit,
      ECPair,
      BIP32
    });
  };

  /**
   * Expand a miniscript to a generalized form using variables instead of key
   * expressions. Variables will be of this form: @0, @1, ...
   * This is done so that it can be compiled with compileMiniscript and
   * satisfied with satisfier.
   * Also compute pubkeys from descriptors to use them later.
   */
  function expandMiniscript({
    miniscript,
    isSegwit,
    network = networks.bitcoin
  }: {
    miniscript: string;
    isSegwit: boolean;
    network?: Network;
  }): {
    expandedMiniscript: string;
    expansionMap: ExpansionMap;
  } {
    return globalExpandMiniscript({
      miniscript,
      isSegwit,
      network,
      BIP32,
      ECPair
    });
  }

  class Descriptor implements DescriptorInterface {
    readonly #payment: Payment;
    readonly #preimages: Preimage[] = [];
    readonly #miniscript?: string;
    readonly #witnessScript?: Buffer;
    readonly #redeemScript?: Buffer;
    readonly #isSegwit?: boolean;
    readonly #expandedExpression?: string;
    readonly #expandedMiniscript?: string;
    readonly #expansionMap?: ExpansionMap;
    readonly #network: Network;
    readonly #signersKeyExpressions: string[] | undefined; //Default value is undefined which means assume that all keyExpression are signers
    /**
     * @param {Object} params
     * @param {number} params.index - The descriptor's index in the case of a range descriptor (must be an interger >=0).
     * @param {string} params.descriptor - The descriptor.
     * @param {boolean} [params.checksumRequired=false] - A flag indicating whether the descriptor is required to include a checksum.
     * @param {object} [params.network=networks.bitcoin] One of bitcoinjs-lib [`networks`](https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/src/networks.js) (or another one following the same interface).
     *
     * @see {@link https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/src/payments/index.d.ts}
     * @throws {Error} - when descriptor is invalid
     */
    constructor({
      expression,
      index,
      checksumRequired = false,
      allowMiniscriptInP2SH = false,
      network = networks.bitcoin,
      preimages = [],
      signersKeyExpressions = undefined //Default value is undefined which means assume that all keyExpression are signers
    }: {
      expression: string;
      index?: number;
      checksumRequired?: boolean;
      allowMiniscriptInP2SH?: boolean;
      network?: Network;
      preimages?: Preimage[];
      signersKeyExpressions: string[] | undefined;
    }) {
      this.#network = network;
      this.#preimages = preimages;
      if (signersKeyExpressions)
        this.#signersKeyExpressions = signersKeyExpressions;
      if (typeof expression !== 'string')
        throw new Error(`Error: invalid descriptor type`);

      //Verify and remove checksum (if exists) and
      //particularize range descriptor for index (if desc is range descriptor)
      const evaluatedExpression = evaluate({
        expression,
        ...(index !== undefined ? { index } : {}),
        checksumRequired
      });

      //addr(ADDR)
      if (evaluatedExpression.match(RE.reAddrAnchored)) {
        const matchedAddress = evaluatedExpression.match(
          RE.reAddrAnchored
        )?.[1]; //[1]-> whatever is found addr(->HERE<-)
        if (!matchedAddress)
          throw new Error(
            `Error: could not get an address in ${evaluatedExpression}`
          );
        let output;
        let payment;
        try {
          output = address.toOutputScript(matchedAddress, network);
        } catch (e) {
          throw new Error(`Error: invalid address ${matchedAddress}`);
        }
        try {
          payment = p2pkh({ output, network });
        } catch (e) {}
        try {
          payment = p2sh({ output, network });
        } catch (e) {}
        try {
          payment = p2wpkh({ output, network });
        } catch (e) {}
        try {
          payment = p2wsh({ output, network });
        } catch (e) {}
        try {
          payment = p2tr({ output, network });
        } catch (e) {}
        if (!payment) {
          throw new Error(`Error: invalid address ${matchedAddress}`);
        }
        this.#payment = payment;
      }
      //pk(KEY)
      else if (evaluatedExpression.match(RE.rePkAnchored)) {
        this.#isSegwit = false;
        const keyExpression = evaluatedExpression.match(RE.reKeyExp)?.[0];
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        if (evaluatedExpression !== `pk(${keyExpression})`)
          throw new Error(`Error: invalid expression ${expression}`);
        this.#expandedExpression = 'pk(@0)';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        //Note there exists no address for p2pk, but we can still use the script
        this.#payment = p2pk({ pubkey, network });
      }
      //pkh(KEY) - legacy
      else if (evaluatedExpression.match(RE.rePkhAnchored)) {
        this.#isSegwit = false;
        const keyExpression = evaluatedExpression.match(RE.reKeyExp)?.[0];
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        if (evaluatedExpression !== `pkh(${keyExpression})`)
          throw new Error(`Error: invalid expression ${expression}`);
        this.#expandedExpression = 'pkh(@0)';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        this.#payment = p2pkh({ pubkey, network });
      }
      //sh(wpkh(KEY)) - nested segwit
      else if (evaluatedExpression.match(RE.reShWpkhAnchored)) {
        this.#isSegwit = true;
        const keyExpression = evaluatedExpression.match(RE.reKeyExp)?.[0];
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        if (evaluatedExpression !== `sh(wpkh(${keyExpression}))`)
          throw new Error(`Error: invalid expression ${expression}`);
        this.#expandedExpression = 'sh(wpkh(@0))';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        this.#payment = p2sh({ redeem: p2wpkh({ pubkey, network }), network });
        //TODO: test this is Ok
        const redeemScript = this.#payment.redeem?.output;
        if (!redeemScript)
          throw new Error(
            `Error: could not calculate redeemScript for ${expression}`
          );
        this.#redeemScript = redeemScript;
      }
      //wpkh(KEY) - native segwit
      else if (evaluatedExpression.match(RE.reWpkhAnchored)) {
        this.#isSegwit = true;
        const keyExpression = evaluatedExpression.match(RE.reKeyExp)?.[0];
        if (!keyExpression)
          throw new Error(`Error: keyExpression could not me extracted`);
        if (evaluatedExpression !== `wpkh(${keyExpression})`)
          throw new Error(`Error: invalid expression ${expression}`);
        this.#expandedExpression = 'wpkh(@0)';
        this.#expansionMap = {
          '@0': parseKeyExpression({
            keyExpression,
            network,
            isSegwit: this.#isSegwit
          })
        };
        const pubkey = this.#expansionMap['@0']!.pubkey;
        this.#payment = p2wpkh({ pubkey, network });
      }
      //sh(wsh(miniscript))
      else if (evaluatedExpression.match(RE.reShWshMiniscriptAnchored)) {
        this.#isSegwit = true;
        const miniscript = evaluatedExpression.match(
          RE.reShWshMiniscriptAnchored
        )?.[1]; //[1]-> whatever is found sh(wsh(->HERE<-))
        if (!miniscript)
          throw new Error(
            `Error: could not get miniscript in ${evaluatedExpression}`
          );
        this.#miniscript = miniscript;
        ({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        } = expandMiniscript({
          miniscript,
          isSegwit: this.#isSegwit,
          network
        }));
        this.#expandedExpression = `sh(wsh(${this.#expandedMiniscript}))`;

        const script = miniscript2Script({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        });
        this.#witnessScript = script;
        if (script.byteLength > MAX_STANDARD_P2WSH_SCRIPT_SIZE) {
          throw new Error(
            `Error: script is too large, ${script.byteLength} bytes is larger than ${MAX_STANDARD_P2WSH_SCRIPT_SIZE} bytes`
          );
        }
        const nonPushOnlyOps = countNonPushOnlyOPs(script);
        if (nonPushOnlyOps > MAX_OPS_PER_SCRIPT) {
          throw new Error(
            `Error: too many non-push ops, ${nonPushOnlyOps} non-push ops is larger than ${MAX_OPS_PER_SCRIPT}`
          );
        }
        this.#payment = p2sh({
          redeem: p2wsh({ redeem: { output: script, network }, network }),
          network
        });
        //TODO: test this is Ok
        const redeemScript = this.#payment.redeem?.output;
        if (!redeemScript)
          throw new Error(
            `Error: could not calculate redeemScript for ${expression}`
          );
        this.#redeemScript = redeemScript;
      }
      //sh(miniscript)
      else if (evaluatedExpression.match(RE.reShMiniscriptAnchored)) {
        this.#isSegwit = false;
        const miniscript = evaluatedExpression.match(
          RE.reShMiniscriptAnchored
        )?.[1]; //[1]-> whatever is found sh(->HERE<-)
        if (!miniscript)
          throw new Error(
            `Error: could not get miniscript in ${evaluatedExpression}`
          );
        if (
          allowMiniscriptInP2SH === false &&
          //These top-level expressions within sh are allowed within sh.
          //They can be parsed with miniscript2Script, but first we must make sure
          //that other expressions are not accepted (unless forced with allowMiniscriptInP2SH).
          miniscript.search(
            /^(pk\(|pkh\(|wpkh\(|combo\(|multi\(|sortedmulti\(|multi_a\(|sortedmulti_a\()/
          ) !== 0
        ) {
          throw new Error(
            `Error: Miniscript expressions can only be used in wsh`
          );
        }
        this.#miniscript = miniscript;
        ({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        } = expandMiniscript({
          miniscript,
          isSegwit: this.#isSegwit,
          network
        }));
        this.#expandedExpression = `sh(${this.#expandedMiniscript})`;

        const script = miniscript2Script({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        });
        this.#redeemScript = script;
        if (script.byteLength > MAX_SCRIPT_ELEMENT_SIZE) {
          throw new Error(
            `Error: P2SH script is too large, ${script.byteLength} bytes is larger than ${MAX_SCRIPT_ELEMENT_SIZE} bytes`
          );
        }
        const nonPushOnlyOps = countNonPushOnlyOPs(script);
        if (nonPushOnlyOps > MAX_OPS_PER_SCRIPT) {
          throw new Error(
            `Error: too many non-push ops, ${nonPushOnlyOps} non-push ops is larger than ${MAX_OPS_PER_SCRIPT}`
          );
        }
        this.#payment = p2sh({ redeem: { output: script, network }, network });
        if (Buffer.compare(script, this.getRedeemScript()!) !== 0)
          throw new Error(
            `Error: redeemScript was not correctly set to the payment in expression ${expression}`
          );
      }
      //wsh(miniscript)
      else if (evaluatedExpression.match(RE.reWshMiniscriptAnchored)) {
        this.#isSegwit = true;
        const miniscript = evaluatedExpression.match(
          RE.reWshMiniscriptAnchored
        )?.[1]; //[1]-> whatever is found wsh(->HERE<-)
        if (!miniscript)
          throw new Error(
            `Error: could not get miniscript in ${evaluatedExpression}`
          );
        this.#miniscript = miniscript;
        ({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        } = expandMiniscript({
          miniscript,
          isSegwit: this.#isSegwit,
          network
        }));
        this.#expandedExpression = `wsh(${this.#expandedMiniscript})`;

        const script = miniscript2Script({
          expandedMiniscript: this.#expandedMiniscript,
          expansionMap: this.#expansionMap
        });
        this.#witnessScript = script;
        if (script.byteLength > MAX_STANDARD_P2WSH_SCRIPT_SIZE) {
          throw new Error(
            `Error: script is too large, ${script.byteLength} bytes is larger than ${MAX_STANDARD_P2WSH_SCRIPT_SIZE} bytes`
          );
        }
        const nonPushOnlyOps = countNonPushOnlyOPs(script);
        if (nonPushOnlyOps > MAX_OPS_PER_SCRIPT) {
          throw new Error(
            `Error: too many non-push ops, ${nonPushOnlyOps} non-push ops is larger than ${MAX_OPS_PER_SCRIPT}`
          );
        }
        this.#payment = p2wsh({ redeem: { output: script, network }, network });
      } else {
        throw new Error(`Error: Could not parse descriptor ${expression}`);
      }
    }

    /** Gets the TimeConstraints of the miniscript descriptor as passed in
     * the constructor, just using the expression and the signersKeyExpressions
     * and preimages. These TimeConstraints must be kept when the final solution
     * using final computed signatures is obtained.
     */
    #getTimeConstraints(): TimeConstraints | undefined {
      const isSegwit = this.#isSegwit;
      const network = this.#network;
      const miniscript = this.#miniscript;
      const preimages = this.#preimages;
      const expandedMiniscript = this.#expandedMiniscript;
      const expansionMap = this.#expansionMap;
      let signersKeyExpressions = this.#signersKeyExpressions;
      //Create a method. solvePreimages to solve them.
      if (miniscript) {
        if (
          expandedMiniscript === undefined ||
          expansionMap === undefined ||
          isSegwit === undefined
        )
          throw new Error(
            `Error: cannot get time constraints from not expanded miniscript ${miniscript}`
          );
        if (!signersKeyExpressions) {
          //signersKeyExpressions can be left unset if all possible signers will
          //sign, although this is not recommended.
          signersKeyExpressions = Object.values(expansionMap).map(
            keyExpression => keyExpression.pubkey.toString('hex')
          );
        }
        //We create some fakeSignatures since we don't have them yet.
        //We only want to retrieve the nLockTime and nSequence of the satisfaction
        const fakeSignatures = signersKeyExpressions.map(keyExpression => ({
          pubkey: parseKeyExpression({ keyExpression, network, isSegwit })
            .pubkey,
          signature: Buffer.alloc(64, 0)
        }));
        const { nLockTime, nSequence } = satisfyMiniscript({
          expandedMiniscript,
          expansionMap,
          signatures: fakeSignatures,
          preimages
        });
        return { nLockTime, nSequence };
      } else return undefined;
    }
    getPayment(): Payment {
      return this.#payment;
    }
    getAddress(): string {
      if (!this.#payment.address)
        throw new Error(`Error: could extract an address from the payment`);
      return this.#payment.address;
    }
    getScriptPubKey(): Buffer {
      if (!this.#payment.output)
        throw new Error(`Error: could extract output.script from the payment`);
      return this.#payment.output;
    }
    getScriptSatisfaction(signatures: PartialSig[]): Buffer {
      const miniscript = this.#miniscript;
      const expandedMiniscript = this.#expandedMiniscript;
      const expansionMap = this.#expansionMap;
      if (
        miniscript === undefined ||
        expandedMiniscript === undefined ||
        expansionMap === undefined
      )
        throw new Error(
          `Error: cannot get satisfaction from not expanded miniscript ${miniscript}`
        );
      //Note that we pass the nLockTime and nSequence that is deduced
      //using preimages and signersKeyExpressions.
      //satisfyMiniscript will make sure
      //that the actual solution given, using real signatures, still meets the
      //same nLockTime and nSequence constraints
      const scriptSatisfaction = satisfyMiniscript({
        expandedMiniscript,
        expansionMap,
        signatures,
        preimages: this.#preimages,
        timeConstraints: {
          nLockTime: this.getLockTime(),
          nSequence: this.getSequence()
        }
      }).scriptSatisfaction;

      if (!scriptSatisfaction)
        throw new Error(`Error: could not produce a valid satisfaction`);
      return scriptSatisfaction;
    }
    getSequence(): number | undefined {
      return this.#getTimeConstraints()?.nSequence;
    }
    getLockTime(): number | undefined {
      return this.#getTimeConstraints()?.nLockTime;
    }
    getWitnessScript(): Buffer | undefined {
      return this.#witnessScript;
    }
    getRedeemScript(): Buffer | undefined {
      return this.#redeemScript;
    }
    isSegwit(): boolean {
      if (this.#isSegwit === undefined)
        throw new Error(
          `Error: could not determine whether this is a segwit descriptor`
        );
      return this.#isSegwit;
    }
    //TODO throw if the txHex+vout don't correspond to the descriptor described
    //also check the redeemScript / witnessScript (if exists)?
    //f.ex. compute the scriptPubKey and assert it's the same.
    //TODO - refactor - move from here
    updatePsbt(txHex: string, vout: number, psbt: Psbt) {
      const tx = Transaction.fromHex(txHex);
      const out = tx?.outs?.[vout];
      if (!out)
        throw new Error(`Error: tx ${txHex} does not have vout ${vout}`);
      const txLockTime = this.getLockTime();
      if (txLockTime !== undefined) {
        if (psbt.locktime !== 0 && psbt.locktime !== undefined)
          throw new Error(
            `Error: transaction locktime has already been set: ${psbt.locktime}`
          );
        psbt.setLocktime(txLockTime);
      }
      let inputSequence = this.getSequence();
      if (txLockTime !== undefined) {
        if (inputSequence === undefined) {
          // for CTV nSequence MUST be <= 0xfffffffe otherwise OP_CHECKLOCKTIMEVERIFY will fail.
          inputSequence = 0xfffffffe;
        } else if (inputSequence > 0xfffffffe)
          throw new Error(
            `Error: incompatible sequence: ${inputSequence} and locktime: ${txLockTime}`
          );
      }

      const input: PsbtInputExtended = {
        hash: tx.getHash(),
        index: vout,
        nonWitnessUtxo: tx.toBuffer()
      };
      if (this.#expansionMap) {
        const bip32Derivation = Object.values(this.#expansionMap)
          .filter(
            (keyInfo: KeyInfo) =>
              keyInfo.pubkey && keyInfo.masterFingerprint && keyInfo.path
          )
          .map(
            (keyInfo: KeyInfo): Bip32Derivation => ({
              masterFingerprint: keyInfo.masterFingerprint!,
              pubkey: keyInfo.pubkey,
              path: keyInfo.path!
            })
          );
        if (bip32Derivation.length) input.bip32Derivation = bip32Derivation;
      }
      if (this.isSegwit())
        input.witnessUtxo = {
          script: this.getScriptPubKey(),
          value: out.value
        };
      if (inputSequence !== undefined) input.sequence = inputSequence;

      const witnessScript = this.getWitnessScript();
      const redeemScript = this.getRedeemScript();
      if (witnessScript) input.witnessScript = witnessScript;
      if (redeemScript) input.redeemScript = redeemScript;

      psbt.addInput(input);
      return psbt.data.inputs.length - 1;
    }

    finalizePsbtInput(index: number, psbt: Psbt) {
      const signatures = psbt.data.inputs[index]?.partialSig;
      if (!signatures)
        throw new Error(`Error: cannot finalize without signatures`);
      const scriptSatisfaction = this.getScriptSatisfaction(signatures);
      if (!scriptSatisfaction) {
        //Use standard finalizers
        psbt.finalizeInput(index);
      } else {
        psbt.finalizeInput(
          index,
          finalScriptsFuncFactory(scriptSatisfaction, this.#network)
        );
      }
    }
    expand(): {
      expandedExpression?: string;
      miniscript?: string;
      expandedMiniscript?: string;
      expansionMap?: ExpansionMap;
    } {
      return {
        ...(this.#expandedExpression !== undefined
          ? { expandedExpression: this.#expandedExpression }
          : {}),
        ...(this.#miniscript !== undefined
          ? { miniscript: this.#miniscript }
          : {}),
        ...(this.#expandedMiniscript !== undefined
          ? { expandedMiniscript: this.#expandedMiniscript }
          : {}),
        ...(this.#expansionMap !== undefined
          ? { expansionMap: this.#expansionMap }
          : {})
      };
    }

    //TODO: move as an external export method
    /**
     * Computes the checksum of a descriptor.
     *
     * @Function
     * @param {string} descriptor - The descriptor.
     * @returns {string} - The checksum.
     */
    static checksum(expression: string): string {
      return DescriptorChecksum(expression);
    }
  }

  return { Descriptor, parseKeyExpression, ECPair, BIP32 };
}
