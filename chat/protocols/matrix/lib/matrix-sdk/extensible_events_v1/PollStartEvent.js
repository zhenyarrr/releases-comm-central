"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.PollStartEvent = exports.PollAnswerSubevent = void 0;
var _matrixEventsSdk = require("matrix-events-sdk");
var _MessageEvent = require("./MessageEvent");
var _extensible_events = require("../@types/extensible_events");
var _polls = require("../@types/polls");
var _InvalidEventError = require("./InvalidEventError");
var _ExtensibleEvent = require("./ExtensibleEvent");
function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); enumerableOnly && (symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; })), keys.push.apply(keys, symbols); } return keys; }
function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = null != arguments[i] ? arguments[i] : {}; i % 2 ? ownKeys(Object(source), !0).forEach(function (key) { _defineProperty(target, key, source[key]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } return target; }
function _defineProperty(obj, key, value) { key = _toPropertyKey(key); if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return typeof key === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (typeof input !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (typeof res !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
/**
 * Represents a poll answer. Note that this is represented as a subtype and is
 * not registered as a parsable event - it is implied for usage exclusively
 * within the PollStartEvent parsing.
 */
class PollAnswerSubevent extends _MessageEvent.MessageEvent {
  /**
   * The answer ID.
   */

  constructor(wireFormat) {
    super(wireFormat);
    _defineProperty(this, "id", void 0);
    const id = wireFormat.content.id;
    if (!id || typeof id !== "string") {
      throw new _InvalidEventError.InvalidEventError("Answer ID must be a non-empty string");
    }
    this.id = id;
  }
  serialize() {
    return {
      type: "org.matrix.sdk.poll.answer",
      content: _objectSpread({
        id: this.id
      }, this.serializeMMessageOnly())
    };
  }

  /**
   * Creates a new PollAnswerSubevent from ID and text.
   * @param id - The answer ID (unique within the poll).
   * @param text - The text.
   * @returns The representative answer.
   */
  static from(id, text) {
    return new PollAnswerSubevent({
      type: "org.matrix.sdk.poll.answer",
      content: {
        id: id,
        [_extensible_events.M_TEXT.name]: text
      }
    });
  }
}

/**
 * Represents a poll start event.
 */
exports.PollAnswerSubevent = PollAnswerSubevent;
class PollStartEvent extends _ExtensibleEvent.ExtensibleEvent {
  /**
   * The question being asked, as a MessageEvent node.
   */

  /**
   * The interpreted kind of poll. Note that this will infer a value that is known to the
   * SDK rather than verbatim - this means unknown types will be represented as undisclosed
   * polls.
   *
   * To get the raw kind, use rawKind.
   */

  /**
   * The true kind as provided by the event sender. Might not be valid.
   */

  /**
   * The maximum number of selections a user is allowed to make.
   */

  /**
   * The possible answers for the poll.
   */

  /**
   * Creates a new PollStartEvent from a pure format. Note that the event is *not*
   * parsed here: it will be treated as a literal m.poll.start primary typed event.
   * @param wireFormat - The event.
   */
  constructor(wireFormat) {
    super(wireFormat);
    _defineProperty(this, "question", void 0);
    _defineProperty(this, "kind", void 0);
    _defineProperty(this, "rawKind", void 0);
    _defineProperty(this, "maxSelections", void 0);
    _defineProperty(this, "answers", void 0);
    const poll = _polls.M_POLL_START.findIn(this.wireContent);
    if (!poll?.question) {
      throw new _InvalidEventError.InvalidEventError("A question is required");
    }
    this.question = new _MessageEvent.MessageEvent({
      type: "org.matrix.sdk.poll.question",
      content: poll.question
    });
    this.rawKind = poll.kind;
    if (_polls.M_POLL_KIND_DISCLOSED.matches(this.rawKind)) {
      this.kind = _polls.M_POLL_KIND_DISCLOSED;
    } else {
      this.kind = _polls.M_POLL_KIND_UNDISCLOSED; // default & assumed value
    }

    this.maxSelections = Number.isFinite(poll.max_selections) && poll.max_selections > 0 ? poll.max_selections : 1;
    if (!Array.isArray(poll.answers)) {
      throw new _InvalidEventError.InvalidEventError("Poll answers must be an array");
    }
    const answers = poll.answers.slice(0, 20).map(a => new PollAnswerSubevent({
      type: "org.matrix.sdk.poll.answer",
      content: a
    }));
    if (answers.length <= 0) {
      throw new _InvalidEventError.InvalidEventError("No answers available");
    }
    this.answers = answers;
  }
  isEquivalentTo(primaryEventType) {
    return (0, _extensible_events.isEventTypeSame)(primaryEventType, _polls.M_POLL_START);
  }
  serialize() {
    return {
      type: _polls.M_POLL_START.name,
      content: {
        [_polls.M_POLL_START.name]: {
          question: this.question.serialize().content,
          kind: this.rawKind,
          max_selections: this.maxSelections,
          answers: this.answers.map(a => a.serialize().content)
        },
        [_extensible_events.M_TEXT.name]: `${this.question.text}\n${this.answers.map((a, i) => `${i + 1}. ${a.text}`).join("\n")}`
      }
    };
  }

  /**
   * Creates a new PollStartEvent from question, answers, and metadata.
   * @param question - The question to ask.
   * @param answers - The answers. Should be unique within each other.
   * @param kind - The kind of poll.
   * @param maxSelections - The maximum number of selections. Must be 1 or higher.
   * @returns The representative poll start event.
   */
  static from(question, answers, kind, maxSelections = 1) {
    return new PollStartEvent({
      type: _polls.M_POLL_START.name,
      content: {
        [_extensible_events.M_TEXT.name]: question,
        // unused by parsing
        [_polls.M_POLL_START.name]: {
          question: {
            [_extensible_events.M_TEXT.name]: question
          },
          kind: kind instanceof _matrixEventsSdk.NamespacedValue ? kind.name : kind,
          max_selections: maxSelections,
          answers: answers.map(a => ({
            id: makeId(),
            [_extensible_events.M_TEXT.name]: a
          }))
        }
      }
    });
  }
}
exports.PollStartEvent = PollStartEvent;
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function makeId() {
  return [...Array(16)].map(() => LETTERS.charAt(Math.floor(Math.random() * LETTERS.length))).join("");
}