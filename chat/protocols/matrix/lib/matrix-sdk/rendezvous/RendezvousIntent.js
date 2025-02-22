"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RendezvousIntent = void 0;
/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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
let RendezvousIntent;
exports.RendezvousIntent = RendezvousIntent;
(function (RendezvousIntent) {
  RendezvousIntent["LOGIN_ON_NEW_DEVICE"] = "login.start";
  RendezvousIntent["RECIPROCATE_LOGIN_ON_EXISTING_DEVICE"] = "login.reciprocate";
})(RendezvousIntent || (exports.RendezvousIntent = RendezvousIntent = {}));