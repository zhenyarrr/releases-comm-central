"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.REFERENCE_RELATION = exports.M_TEXT = exports.M_MESSAGE = exports.M_HTML = void 0;
exports.isEventTypeSame = isEventTypeSame;
var _matrixEventsSdk = require("matrix-events-sdk");
var _utilities = require("../extensible_events_v1/utilities");
/*
Copyright 2021 - 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * The namespaced value for m.message
 */
const M_MESSAGE = new _matrixEventsSdk.UnstableValue("m.message", "org.matrix.msc1767.message");

/**
 * An m.message event rendering
 */
exports.M_MESSAGE = M_MESSAGE;
/**
 * The namespaced value for m.text
 */
const M_TEXT = new _matrixEventsSdk.UnstableValue("m.text", "org.matrix.msc1767.text");

/**
 * The content for an m.text event
 */
exports.M_TEXT = M_TEXT;
/**
 * The namespaced value for m.html
 */
const M_HTML = new _matrixEventsSdk.UnstableValue("m.html", "org.matrix.msc1767.html");

/**
 * The content for an m.html event
 */
exports.M_HTML = M_HTML;
/**
 * The namespaced value for an m.reference relation
 */
const REFERENCE_RELATION = new _matrixEventsSdk.NamespacedValue("m.reference");

/**
 * Represents any relation type
 */
exports.REFERENCE_RELATION = REFERENCE_RELATION;
/**
 * Determines if two event types are the same, including namespaces.
 * @param given - The given event type. This will be compared
 * against the expected type.
 * @param expected - The expected event type.
 * @returns True if the given type matches the expected type.
 */
function isEventTypeSame(given, expected) {
  if (typeof given === "string") {
    if (typeof expected === "string") {
      return expected === given;
    } else {
      return expected.matches(given);
    }
  } else {
    if (typeof expected === "string") {
      return given.matches(expected);
    } else {
      const expectedNs = expected;
      const givenNs = given;
      return expectedNs.matches(givenNs.name) || (0, _utilities.isProvided)(givenNs.altName) && expectedNs.matches(givenNs.altName);
    }
  }
}