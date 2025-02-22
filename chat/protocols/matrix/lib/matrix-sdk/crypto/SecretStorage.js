"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.SecretStorage = exports.SECRET_STORAGE_ALGORITHM_V1_AES = void 0;
var _uuid = require("uuid");
var _logger = require("../logger");
var olmlib = _interopRequireWildcard(require("./olmlib"));
var _randomstring = require("../randomstring");
var _aes = require("./aes");
var _client = require("../client");
var _utils = require("../utils");
var _event = require("../@types/event");
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
function _defineProperty(obj, key, value) { key = _toPropertyKey(key); if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return typeof key === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (typeof input !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (typeof res !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
const SECRET_STORAGE_ALGORITHM_V1_AES = "m.secret_storage.v1.aes-hmac-sha2";

// Some of the key functions use a tuple and some use an object...
exports.SECRET_STORAGE_ALGORITHM_V1_AES = SECRET_STORAGE_ALGORITHM_V1_AES;
/**
 * Implements Secure Secret Storage and Sharing (MSC1946)
 */
class SecretStorage {
  // In it's pure javascript days, this was relying on some proper Javascript-style
  // type-abuse where sometimes we'd pass in a fake client object with just the account
  // data methods implemented, which is all this class needs unless you use the secret
  // sharing code, so it was fine. As a low-touch TypeScript migration, this now has
  // an extra, optional param for a real matrix client, so you can not pass it as long
  // as you don't request any secrets.
  // A better solution would probably be to split this class up into secret storage and
  // secret sharing which are really two separate things, even though they share an MSC.
  constructor(accountDataAdapter, cryptoCallbacks, baseApis) {
    this.accountDataAdapter = accountDataAdapter;
    this.cryptoCallbacks = cryptoCallbacks;
    this.baseApis = baseApis;
    _defineProperty(this, "requests", new Map());
  }
  async getDefaultKeyId() {
    const defaultKey = await this.accountDataAdapter.getAccountDataFromServer("m.secret_storage.default_key");
    if (!defaultKey) return null;
    return defaultKey.key;
  }
  setDefaultKeyId(keyId) {
    return new Promise((resolve, reject) => {
      const listener = ev => {
        if (ev.getType() === "m.secret_storage.default_key" && ev.getContent().key === keyId) {
          this.accountDataAdapter.removeListener(_client.ClientEvent.AccountData, listener);
          resolve();
        }
      };
      this.accountDataAdapter.on(_client.ClientEvent.AccountData, listener);
      this.accountDataAdapter.setAccountData("m.secret_storage.default_key", {
        key: keyId
      }).catch(e => {
        this.accountDataAdapter.removeListener(_client.ClientEvent.AccountData, listener);
        reject(e);
      });
    });
  }

  /**
   * Add a key for encrypting secrets.
   *
   * @param algorithm - the algorithm used by the key.
   * @param opts - the options for the algorithm.  The properties used
   *     depend on the algorithm given.
   * @param keyId - the ID of the key.  If not given, a random
   *     ID will be generated.
   *
   * @returns An object with:
   *     keyId: the ID of the key
   *     keyInfo: details about the key (iv, mac, passphrase)
   */
  async addKey(algorithm, opts = {}, keyId) {
    const keyInfo = {
      algorithm
    };
    if (opts.name) {
      keyInfo.name = opts.name;
    }
    if (algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
      if (opts.passphrase) {
        keyInfo.passphrase = opts.passphrase;
      }
      if (opts.key) {
        const {
          iv,
          mac
        } = await (0, _aes.calculateKeyCheck)(opts.key);
        keyInfo.iv = iv;
        keyInfo.mac = mac;
      }
    } else {
      throw new Error(`Unknown key algorithm ${algorithm}`);
    }
    if (!keyId) {
      do {
        keyId = (0, _randomstring.randomString)(32);
      } while (await this.accountDataAdapter.getAccountDataFromServer(`m.secret_storage.key.${keyId}`));
    }
    await this.accountDataAdapter.setAccountData(`m.secret_storage.key.${keyId}`, keyInfo);
    return {
      keyId,
      keyInfo
    };
  }

  /**
   * Get the key information for a given ID.
   *
   * @param keyId - The ID of the key to check
   *     for. Defaults to the default key ID if not provided.
   * @returns If the key was found, the return value is an array of
   *     the form [keyId, keyInfo].  Otherwise, null is returned.
   *     XXX: why is this an array when addKey returns an object?
   */
  async getKey(keyId) {
    if (!keyId) {
      keyId = await this.getDefaultKeyId();
    }
    if (!keyId) {
      return null;
    }
    const keyInfo = await this.accountDataAdapter.getAccountDataFromServer("m.secret_storage.key." + keyId);
    return keyInfo ? [keyId, keyInfo] : null;
  }

  /**
   * Check whether we have a key with a given ID.
   *
   * @param keyId - The ID of the key to check
   *     for. Defaults to the default key ID if not provided.
   * @returns Whether we have the key.
   */
  async hasKey(keyId) {
    return Boolean(await this.getKey(keyId));
  }

  /**
   * Check whether a key matches what we expect based on the key info
   *
   * @param key - the key to check
   * @param info - the key info
   *
   * @returns whether or not the key matches
   */
  async checkKey(key, info) {
    if (info.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
      if (info.mac) {
        const {
          mac
        } = await (0, _aes.calculateKeyCheck)(key, info.iv);
        return info.mac.replace(/=+$/g, "") === mac.replace(/=+$/g, "");
      } else {
        // if we have no information, we have to assume the key is right
        return true;
      }
    } else {
      throw new Error("Unknown algorithm");
    }
  }

  /**
   * Store an encrypted secret on the server
   *
   * @param name - The name of the secret
   * @param secret - The secret contents.
   * @param keys - The IDs of the keys to use to encrypt the secret
   *     or null/undefined to use the default key.
   */
  async store(name, secret, keys) {
    const encrypted = {};
    if (!keys) {
      const defaultKeyId = await this.getDefaultKeyId();
      if (!defaultKeyId) {
        throw new Error("No keys specified and no default key present");
      }
      keys = [defaultKeyId];
    }
    if (keys.length === 0) {
      throw new Error("Zero keys given to encrypt with!");
    }
    for (const keyId of keys) {
      // get key information from key storage
      const keyInfo = await this.accountDataAdapter.getAccountDataFromServer("m.secret_storage.key." + keyId);
      if (!keyInfo) {
        throw new Error("Unknown key: " + keyId);
      }

      // encrypt secret, based on the algorithm
      if (keyInfo.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
        const keys = {
          [keyId]: keyInfo
        };
        const [, encryption] = await this.getSecretStorageKey(keys, name);
        encrypted[keyId] = await encryption.encrypt(secret);
      } else {
        _logger.logger.warn("unknown algorithm for secret storage key " + keyId + ": " + keyInfo.algorithm);
        // do nothing if we don't understand the encryption algorithm
      }
    }

    // save encrypted secret
    await this.accountDataAdapter.setAccountData(name, {
      encrypted
    });
  }

  /**
   * Get a secret from storage.
   *
   * @param name - the name of the secret
   *
   * @returns the contents of the secret
   */
  async get(name) {
    const secretInfo = await this.accountDataAdapter.getAccountDataFromServer(name);
    if (!secretInfo) {
      return;
    }
    if (!secretInfo.encrypted) {
      throw new Error("Content is not encrypted!");
    }

    // get possible keys to decrypt
    const keys = {};
    for (const keyId of Object.keys(secretInfo.encrypted)) {
      // get key information from key storage
      const keyInfo = await this.accountDataAdapter.getAccountDataFromServer("m.secret_storage.key." + keyId);
      const encInfo = secretInfo.encrypted[keyId];
      // only use keys we understand the encryption algorithm of
      if (keyInfo.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
        if (encInfo.iv && encInfo.ciphertext && encInfo.mac) {
          keys[keyId] = keyInfo;
        }
      }
    }
    if (Object.keys(keys).length === 0) {
      throw new Error(`Could not decrypt ${name} because none of ` + `the keys it is encrypted with are for a supported algorithm`);
    }

    // fetch private key from app
    const [keyId, decryption] = await this.getSecretStorageKey(keys, name);
    const encInfo = secretInfo.encrypted[keyId];
    return decryption.decrypt(encInfo);
  }

  /**
   * Check if a secret is stored on the server.
   *
   * @param name - the name of the secret
   *
   * @returns map of key name to key info the secret is encrypted
   *     with, or null if it is not present or not encrypted with a trusted
   *     key
   */
  async isStored(name) {
    // check if secret exists
    const secretInfo = await this.accountDataAdapter.getAccountDataFromServer(name);
    if (!secretInfo?.encrypted) return null;
    const ret = {};

    // filter secret encryption keys with supported algorithm
    for (const keyId of Object.keys(secretInfo.encrypted)) {
      // get key information from key storage
      const keyInfo = await this.accountDataAdapter.getAccountDataFromServer("m.secret_storage.key." + keyId);
      if (!keyInfo) continue;
      const encInfo = secretInfo.encrypted[keyId];

      // only use keys we understand the encryption algorithm of
      if (keyInfo.algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
        if (encInfo.iv && encInfo.ciphertext && encInfo.mac) {
          ret[keyId] = keyInfo;
        }
      }
    }
    return Object.keys(ret).length ? ret : null;
  }

  /**
   * Request a secret from another device
   *
   * @param name - the name of the secret to request
   * @param devices - the devices to request the secret from
   */
  request(name, devices) {
    const requestId = this.baseApis.makeTxnId();
    const deferred = (0, _utils.defer)();
    this.requests.set(requestId, {
      name,
      devices,
      deferred
    });
    const cancel = reason => {
      // send cancellation event
      const cancelData = {
        action: "request_cancellation",
        requesting_device_id: this.baseApis.deviceId,
        request_id: requestId
      };
      const toDevice = new Map();
      for (const device of devices) {
        toDevice.set(device, cancelData);
      }
      this.baseApis.sendToDevice("m.secret.request", new Map([[this.baseApis.getUserId(), toDevice]]));

      // and reject the promise so that anyone waiting on it will be
      // notified
      deferred.reject(new Error(reason || "Cancelled"));
    };

    // send request to devices
    const requestData = {
      name,
      action: "request",
      requesting_device_id: this.baseApis.deviceId,
      request_id: requestId,
      [_event.ToDeviceMessageId]: (0, _uuid.v4)()
    };
    const toDevice = new Map();
    for (const device of devices) {
      toDevice.set(device, requestData);
    }
    _logger.logger.info(`Request secret ${name} from ${devices}, id ${requestId}`);
    this.baseApis.sendToDevice("m.secret.request", new Map([[this.baseApis.getUserId(), toDevice]]));
    return {
      requestId,
      promise: deferred.promise,
      cancel
    };
  }
  async onRequestReceived(event) {
    const sender = event.getSender();
    const content = event.getContent();
    if (sender !== this.baseApis.getUserId() || !(content.name && content.action && content.requesting_device_id && content.request_id)) {
      // ignore requests from anyone else, for now
      return;
    }
    const deviceId = content.requesting_device_id;
    // check if it's a cancel
    if (content.action === "request_cancellation") {
      /*
      Looks like we intended to emit events when we got cancelations, but
      we never put anything in the _incomingRequests object, and the request
      itself doesn't use events anyway so if we were to wire up cancellations,
      they probably ought to use the same callback interface. I'm leaving them
      disabled for now while converting this file to typescript.
      if (this._incomingRequests[deviceId]
          && this._incomingRequests[deviceId][content.request_id]) {
          logger.info(
              "received request cancellation for secret (" + sender +
              ", " + deviceId + ", " + content.request_id + ")",
          );
          this.baseApis.emit("crypto.secrets.requestCancelled", {
              user_id: sender,
              device_id: deviceId,
              request_id: content.request_id,
          });
      }
      */
    } else if (content.action === "request") {
      if (deviceId === this.baseApis.deviceId) {
        // no point in trying to send ourself the secret
        return;
      }

      // check if we have the secret
      _logger.logger.info("received request for secret (" + sender + ", " + deviceId + ", " + content.request_id + ")");
      if (!this.cryptoCallbacks.onSecretRequested) {
        return;
      }
      const secret = await this.cryptoCallbacks.onSecretRequested(sender, deviceId, content.request_id, content.name, this.baseApis.checkDeviceTrust(sender, deviceId));
      if (secret) {
        _logger.logger.info(`Preparing ${content.name} secret for ${deviceId}`);
        const payload = {
          type: "m.secret.send",
          content: {
            request_id: content.request_id,
            secret: secret
          }
        };
        const encryptedContent = {
          algorithm: olmlib.OLM_ALGORITHM,
          sender_key: this.baseApis.crypto.olmDevice.deviceCurve25519Key,
          ciphertext: {},
          [_event.ToDeviceMessageId]: (0, _uuid.v4)()
        };
        await olmlib.ensureOlmSessionsForDevices(this.baseApis.crypto.olmDevice, this.baseApis, new Map([[sender, [this.baseApis.getStoredDevice(sender, deviceId)]]]));
        await olmlib.encryptMessageForDevice(encryptedContent.ciphertext, this.baseApis.getUserId(), this.baseApis.deviceId, this.baseApis.crypto.olmDevice, sender, this.baseApis.getStoredDevice(sender, deviceId), payload);
        const contentMap = new Map([[sender, new Map([[deviceId, encryptedContent]])]]);
        _logger.logger.info(`Sending ${content.name} secret for ${deviceId}`);
        this.baseApis.sendToDevice("m.room.encrypted", contentMap);
      } else {
        _logger.logger.info(`Request denied for ${content.name} secret for ${deviceId}`);
      }
    }
  }
  onSecretReceived(event) {
    if (event.getSender() !== this.baseApis.getUserId()) {
      // we shouldn't be receiving secrets from anyone else, so ignore
      // because someone could be trying to send us bogus data
      return;
    }
    if (!olmlib.isOlmEncrypted(event)) {
      _logger.logger.error("secret event not properly encrypted");
      return;
    }
    const content = event.getContent();
    const senderKeyUser = this.baseApis.crypto.deviceList.getUserByIdentityKey(olmlib.OLM_ALGORITHM, event.getSenderKey() || "");
    if (senderKeyUser !== event.getSender()) {
      _logger.logger.error("sending device does not belong to the user it claims to be from");
      return;
    }
    _logger.logger.log("got secret share for request", content.request_id);
    const requestControl = this.requests.get(content.request_id);
    if (requestControl) {
      // make sure that the device that sent it is one of the devices that
      // we requested from
      const deviceInfo = this.baseApis.crypto.deviceList.getDeviceByIdentityKey(olmlib.OLM_ALGORITHM, event.getSenderKey());
      if (!deviceInfo) {
        _logger.logger.log("secret share from unknown device with key", event.getSenderKey());
        return;
      }
      if (!requestControl.devices.includes(deviceInfo.deviceId)) {
        _logger.logger.log("unsolicited secret share from device", deviceInfo.deviceId);
        return;
      }
      // unsure that the sender is trusted.  In theory, this check is
      // unnecessary since we only accept secret shares from devices that
      // we requested from, but it doesn't hurt.
      const deviceTrust = this.baseApis.crypto.checkDeviceInfoTrust(event.getSender(), deviceInfo);
      if (!deviceTrust.isVerified()) {
        _logger.logger.log("secret share from unverified device");
        return;
      }
      _logger.logger.log(`Successfully received secret ${requestControl.name} ` + `from ${deviceInfo.deviceId}`);
      requestControl.deferred.resolve(content.secret);
    }
  }
  async getSecretStorageKey(keys, name) {
    if (!this.cryptoCallbacks.getSecretStorageKey) {
      throw new Error("No getSecretStorageKey callback supplied");
    }
    const returned = await this.cryptoCallbacks.getSecretStorageKey({
      keys
    }, name);
    if (!returned) {
      throw new Error("getSecretStorageKey callback returned falsey");
    }
    if (returned.length < 2) {
      throw new Error("getSecretStorageKey callback returned invalid data");
    }
    const [keyId, privateKey] = returned;
    if (!keys[keyId]) {
      throw new Error("App returned unknown key from getSecretStorageKey!");
    }
    if (keys[keyId].algorithm === SECRET_STORAGE_ALGORITHM_V1_AES) {
      const decryption = {
        encrypt: function (secret) {
          return (0, _aes.encryptAES)(secret, privateKey, name);
        },
        decrypt: function (encInfo) {
          return (0, _aes.decryptAES)(encInfo, privateKey, name);
        }
      };
      return [keyId, decryption];
    } else {
      throw new Error("Unknown key type: " + keys[keyId].algorithm);
    }
  }
}
exports.SecretStorage = SecretStorage;