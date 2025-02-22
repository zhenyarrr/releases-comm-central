"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.InteractiveAuth = exports.AuthType = void 0;
var _logger = require("./logger");
var _utils = require("./utils");
function _defineProperty(obj, key, value) { key = _toPropertyKey(key); if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return typeof key === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (typeof input !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (typeof res !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
const EMAIL_STAGE_TYPE = "m.login.email.identity";
const MSISDN_STAGE_TYPE = "m.login.msisdn";
let AuthType;
exports.AuthType = AuthType;
(function (AuthType) {
  AuthType["Password"] = "m.login.password";
  AuthType["Recaptcha"] = "m.login.recaptcha";
  AuthType["Terms"] = "m.login.terms";
  AuthType["Email"] = "m.login.email.identity";
  AuthType["Msisdn"] = "m.login.msisdn";
  AuthType["Sso"] = "m.login.sso";
  AuthType["SsoUnstable"] = "org.matrix.login.sso";
  AuthType["Dummy"] = "m.login.dummy";
  AuthType["RegistrationToken"] = "m.login.registration_token";
  AuthType["UnstableRegistrationToken"] = "org.matrix.msc3231.login.registration_token";
})(AuthType || (exports.AuthType = AuthType = {}));
class NoAuthFlowFoundError extends Error {
  // eslint-disable-next-line @typescript-eslint/naming-convention, camelcase
  constructor(m, required_stages, flows) {
    super(m);
    this.required_stages = required_stages;
    this.flows = flows;
    _defineProperty(this, "name", "NoAuthFlowFoundError");
  }
}
/**
 * Abstracts the logic used to drive the interactive auth process.
 *
 * <p>Components implementing an interactive auth flow should instantiate one of
 * these, passing in the necessary callbacks to the constructor. They should
 * then call attemptAuth, which will return a promise which will resolve or
 * reject when the interactive-auth process completes.
 *
 * <p>Meanwhile, calls will be made to the startAuthStage and doRequest
 * callbacks, and information gathered from the user can be submitted with
 * submitAuthDict.
 *
 * @param opts - options object
 */
class InteractiveAuth {
  // if we are currently trying to submit an auth dict (which includes polling)
  // the promise the will resolve/reject when it completes

  constructor(opts) {
    _defineProperty(this, "matrixClient", void 0);
    _defineProperty(this, "inputs", void 0);
    _defineProperty(this, "clientSecret", void 0);
    _defineProperty(this, "requestCallback", void 0);
    _defineProperty(this, "busyChangedCallback", void 0);
    _defineProperty(this, "stateUpdatedCallback", void 0);
    _defineProperty(this, "requestEmailTokenCallback", void 0);
    _defineProperty(this, "data", void 0);
    _defineProperty(this, "emailSid", void 0);
    _defineProperty(this, "requestingEmailToken", false);
    _defineProperty(this, "attemptAuthDeferred", null);
    _defineProperty(this, "chosenFlow", null);
    _defineProperty(this, "currentStage", null);
    _defineProperty(this, "emailAttempt", 1);
    _defineProperty(this, "submitPromise", null);
    _defineProperty(this, "requestEmailToken", async () => {
      if (!this.requestingEmailToken) {
        _logger.logger.trace("Requesting email token. Attempt: " + this.emailAttempt);
        // If we've picked a flow with email auth, we send the email
        // now because we want the request to fail as soon as possible
        // if the email address is not valid (ie. already taken or not
        // registered, depending on what the operation is).
        this.requestingEmailToken = true;
        try {
          const requestTokenResult = await this.requestEmailTokenCallback(this.inputs.emailAddress, this.clientSecret, this.emailAttempt++, this.data.session);
          this.emailSid = requestTokenResult.sid;
          _logger.logger.trace("Email token request succeeded");
        } finally {
          this.requestingEmailToken = false;
        }
      } else {
        _logger.logger.warn("Could not request email token: Already requesting");
      }
    });
    this.matrixClient = opts.matrixClient;
    this.data = opts.authData || {};
    this.requestCallback = opts.doRequest;
    this.busyChangedCallback = opts.busyChanged;
    // startAuthStage included for backwards compat
    this.stateUpdatedCallback = opts.stateUpdated || opts.startAuthStage;
    this.requestEmailTokenCallback = opts.requestEmailToken;
    this.inputs = opts.inputs || {};
    if (opts.sessionId) this.data.session = opts.sessionId;
    this.clientSecret = opts.clientSecret || this.matrixClient.generateClientSecret();
    this.emailSid = opts.emailSid;
  }

  /**
   * begin the authentication process.
   *
   * @returns which resolves to the response on success,
   * or rejects with the error on failure. Rejects with NoAuthFlowFoundError if
   *     no suitable authentication flow can be found
   */
  attemptAuth() {
    // This promise will be quite long-lived and will resolve when the
    // request is authenticated and completes successfully.
    this.attemptAuthDeferred = (0, _utils.defer)();
    // pluck the promise out now, as doRequest may clear before we return
    const promise = this.attemptAuthDeferred.promise;

    // if we have no flows, try a request to acquire the flows
    if (!this.data?.flows) {
      this.busyChangedCallback?.(true);
      // use the existing sessionId, if one is present.
      const auth = this.data.session ? {
        session: this.data.session
      } : null;
      this.doRequest(auth).finally(() => {
        this.busyChangedCallback?.(false);
      });
    } else {
      this.startNextAuthStage();
    }
    return promise;
  }

  /**
   * Poll to check if the auth session or current stage has been
   * completed out-of-band. If so, the attemptAuth promise will
   * be resolved.
   */
  async poll() {
    if (!this.data.session) return;
    // likewise don't poll if there is no auth session in progress
    if (!this.attemptAuthDeferred) return;
    // if we currently have a request in flight, there's no point making
    // another just to check what the status is
    if (this.submitPromise) return;
    let authDict = {};
    if (this.currentStage == EMAIL_STAGE_TYPE) {
      // The email can be validated out-of-band, but we need to provide the
      // creds so the HS can go & check it.
      if (this.emailSid) {
        const creds = {
          sid: this.emailSid,
          client_secret: this.clientSecret
        };
        if (await this.matrixClient.doesServerRequireIdServerParam()) {
          const idServerParsedUrl = new URL(this.matrixClient.getIdentityServerUrl());
          creds.id_server = idServerParsedUrl.host;
        }
        authDict = {
          type: EMAIL_STAGE_TYPE,
          // TODO: Remove `threepid_creds` once servers support proper UIA
          // See https://github.com/matrix-org/synapse/issues/5665
          // See https://github.com/matrix-org/matrix-doc/issues/2220
          threepid_creds: creds,
          threepidCreds: creds
        };
      }
    }
    this.submitAuthDict(authDict, true);
  }

  /**
   * get the auth session ID
   *
   * @returns session id
   */
  getSessionId() {
    return this.data?.session;
  }

  /**
   * get the client secret used for validation sessions
   * with the identity server.
   *
   * @returns client secret
   */
  getClientSecret() {
    return this.clientSecret;
  }

  /**
   * get the server params for a given stage
   *
   * @param loginType - login type for the stage
   * @returns any parameters from the server for this stage
   */
  getStageParams(loginType) {
    return this.data.params?.[loginType];
  }
  getChosenFlow() {
    return this.chosenFlow;
  }

  /**
   * submit a new auth dict and fire off the request. This will either
   * make attemptAuth resolve/reject, or cause the startAuthStage callback
   * to be called for a new stage.
   *
   * @param authData - new auth dict to send to the server. Should
   *    include a `type` property denoting the login type, as well as any
   *    other params for that stage.
   * @param background - If true, this request failing will not result
   *    in the attemptAuth promise being rejected. This can be set to true
   *    for requests that just poll to see if auth has been completed elsewhere.
   */
  async submitAuthDict(authData, background = false) {
    if (!this.attemptAuthDeferred) {
      throw new Error("submitAuthDict() called before attemptAuth()");
    }
    if (!background) {
      this.busyChangedCallback?.(true);
    }

    // if we're currently trying a request, wait for it to finish
    // as otherwise we can get multiple 200 responses which can mean
    // things like multiple logins for register requests.
    // (but discard any exceptions as we only care when its done,
    // not whether it worked or not)
    while (this.submitPromise) {
      try {
        await this.submitPromise;
      } catch (e) {}
    }

    // use the sessionid from the last request, if one is present.
    let auth;
    if (this.data.session) {
      auth = {
        session: this.data.session
      };
      Object.assign(auth, authData);
    } else {
      auth = authData;
    }
    try {
      // NB. the 'background' flag is deprecated by the busyChanged
      // callback and is here for backwards compat
      this.submitPromise = this.doRequest(auth, background);
      await this.submitPromise;
    } finally {
      this.submitPromise = null;
      if (!background) {
        this.busyChangedCallback?.(false);
      }
    }
  }

  /**
   * Gets the sid for the email validation session
   * Specific to m.login.email.identity
   *
   * @returns The sid of the email auth session
   */
  getEmailSid() {
    return this.emailSid;
  }

  /**
   * Sets the sid for the email validation session
   * This must be set in order to successfully poll for completion
   * of the email validation.
   * Specific to m.login.email.identity
   *
   * @param sid - The sid for the email validation session
   */
  setEmailSid(sid) {
    this.emailSid = sid;
  }

  /**
   * Requests a new email token and sets the email sid for the validation session
   */

  /**
   * Fire off a request, and either resolve the promise, or call
   * startAuthStage.
   *
   * @internal
   * @param auth - new auth dict, including session id
   * @param background - If true, this request is a background poll, so it
   *    failing will not result in the attemptAuth promise being rejected.
   *    This can be set to true for requests that just poll to see if auth has
   *    been completed elsewhere.
   */
  async doRequest(auth, background = false) {
    try {
      const result = await this.requestCallback(auth, background);
      this.attemptAuthDeferred.resolve(result);
      this.attemptAuthDeferred = null;
    } catch (error) {
      // sometimes UI auth errors don't come with flows
      const errorFlows = error.data?.flows ?? null;
      const haveFlows = this.data.flows || Boolean(errorFlows);
      if (error.httpStatus !== 401 || !error.data || !haveFlows) {
        // doesn't look like an interactive-auth failure.
        if (!background) {
          this.attemptAuthDeferred?.reject(error);
        } else {
          // We ignore all failures here (even non-UI auth related ones)
          // since we don't want to suddenly fail if the internet connection
          // had a blip whilst we were polling
          _logger.logger.log("Background poll request failed doing UI auth: ignoring", error);
        }
      }
      if (!error.data) {
        error.data = {};
      }
      // if the error didn't come with flows, completed flows or session ID,
      // copy over the ones we have. Synapse sometimes sends responses without
      // any UI auth data (eg. when polling for email validation, if the email
      // has not yet been validated). This appears to be a Synapse bug, which
      // we workaround here.
      if (!error.data.flows && !error.data.completed && !error.data.session) {
        error.data.flows = this.data.flows;
        error.data.completed = this.data.completed;
        error.data.session = this.data.session;
      }
      this.data = error.data;
      try {
        this.startNextAuthStage();
      } catch (e) {
        this.attemptAuthDeferred.reject(e);
        this.attemptAuthDeferred = null;
        return;
      }
      if (!this.emailSid && this.chosenFlow?.stages.includes(AuthType.Email)) {
        try {
          await this.requestEmailToken();
          // NB. promise is not resolved here - at some point, doRequest
          // will be called again and if the user has jumped through all
          // the hoops correctly, auth will be complete and the request
          // will succeed.
          // Also, we should expose the fact that this request has compledted
          // so clients can know that the email has actually been sent.
        } catch (e) {
          // we failed to request an email token, so fail the request.
          // This could be due to the email already beeing registered
          // (or not being registered, depending on what we're trying
          // to do) or it could be a network failure. Either way, pass
          // the failure up as the user can't complete auth if we can't
          // send the email, for whatever reason.
          this.attemptAuthDeferred.reject(e);
          this.attemptAuthDeferred = null;
        }
      }
    }
  }

  /**
   * Pick the next stage and call the callback
   *
   * @internal
   * @throws {@link NoAuthFlowFoundError} If no suitable authentication flow can be found
   */
  startNextAuthStage() {
    const nextStage = this.chooseStage();
    if (!nextStage) {
      throw new Error("No incomplete flows from the server");
    }
    this.currentStage = nextStage;
    if (nextStage === AuthType.Dummy) {
      this.submitAuthDict({
        type: "m.login.dummy"
      });
      return;
    }
    if (this.data?.errcode || this.data?.error) {
      this.stateUpdatedCallback(nextStage, {
        errcode: this.data?.errcode || "",
        error: this.data?.error || ""
      });
      return;
    }
    this.stateUpdatedCallback(nextStage, nextStage === EMAIL_STAGE_TYPE ? {
      emailSid: this.emailSid
    } : {});
  }

  /**
   * Pick the next auth stage
   *
   * @internal
   * @returns login type
   * @throws {@link NoAuthFlowFoundError} If no suitable authentication flow can be found
   */
  chooseStage() {
    if (this.chosenFlow === null) {
      this.chosenFlow = this.chooseFlow();
    }
    _logger.logger.log("Active flow => %s", JSON.stringify(this.chosenFlow));
    const nextStage = this.firstUncompletedStage(this.chosenFlow);
    _logger.logger.log("Next stage: %s", nextStage);
    return nextStage;
  }

  /**
   * Pick one of the flows from the returned list
   * If a flow using all of the inputs is found, it will
   * be returned, otherwise, null will be returned.
   *
   * Only flows using all given inputs are chosen because it
   * is likely to be surprising if the user provides a
   * credential and it is not used. For example, for registration,
   * this could result in the email not being used which would leave
   * the account with no means to reset a password.
   *
   * @internal
   * @returns flow
   * @throws {@link NoAuthFlowFoundError} If no suitable authentication flow can be found
   */
  chooseFlow() {
    const flows = this.data.flows || [];

    // we've been given an email or we've already done an email part
    const haveEmail = Boolean(this.inputs.emailAddress) || Boolean(this.emailSid);
    const haveMsisdn = Boolean(this.inputs.phoneCountry) && Boolean(this.inputs.phoneNumber);
    for (const flow of flows) {
      let flowHasEmail = false;
      let flowHasMsisdn = false;
      for (const stage of flow.stages) {
        if (stage === EMAIL_STAGE_TYPE) {
          flowHasEmail = true;
        } else if (stage == MSISDN_STAGE_TYPE) {
          flowHasMsisdn = true;
        }
      }
      if (flowHasEmail == haveEmail && flowHasMsisdn == haveMsisdn) {
        return flow;
      }
    }
    const requiredStages = [];
    if (haveEmail) requiredStages.push(EMAIL_STAGE_TYPE);
    if (haveMsisdn) requiredStages.push(MSISDN_STAGE_TYPE);
    // Throw an error with a fairly generic description, but with more
    // information such that the app can give a better one if so desired.
    throw new NoAuthFlowFoundError("No appropriate authentication flow found", requiredStages, flows);
  }

  /**
   * Get the first uncompleted stage in the given flow
   *
   * @internal
   * @returns login type
   */
  firstUncompletedStage(flow) {
    const completed = this.data.completed || [];
    return flow.stages.find(stageType => !completed.includes(stageType));
  }
}
exports.InteractiveAuth = InteractiveAuth;