/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { EnigmailFuncs } = ChromeUtils.import(
  "chrome://openpgp/content/modules/funcs.jsm"
);
var { EnigmailDialog } = ChromeUtils.import(
  "chrome://openpgp/content/modules/dialog.jsm"
);
var { EnigmailKeyRing } = ChromeUtils.import(
  "chrome://openpgp/content/modules/keyRing.jsm"
);
var { EnigmailWindows } = ChromeUtils.import(
  "chrome://openpgp/content/modules/windows.jsm"
);
var { EnigmailKey } = ChromeUtils.import(
  "chrome://openpgp/content/modules/key.jsm"
);
var { RNP, RnpPrivateKeyUnlockTracker } = ChromeUtils.import(
  "chrome://openpgp/content/modules/RNP.jsm"
);

let gRadio;
let gFingerprints = [];
let gKeyCreated;

let myl10n = new Localization(["messenger/openpgp/changeExpiryDlg.ftl"], true);

function onLoad() {
  let params = window.arguments[0];
  if (!params) {
    return;
  }
  let keyObj = EnigmailKeyRing.getKeyById(params.keyId);
  if (!keyObj || !keyObj.secretAvailable) {
    return;
  }

  if (!keyObj.iSimpleOneSubkeySameExpiry()) {
    window.close();
    return;
  }

  gFingerprints = [keyObj.fpr, keyObj.subKeys[0].fpr];
  gKeyCreated = keyObj.keyCreated;

  gRadio = document.getElementById("radio-expire-or-not");

  let monthsMin = 1;
  let monthsMax = 120;
  let monthsSel = 24;

  let infoExpiryText;
  if (!keyObj.expiryTime) {
    infoExpiryText = myl10n.formatValueSync("info-does-not-expire");
  } else {
    let nowSeconds = Math.floor(Date.now() / 1000);
    if (keyObj.expiryTime < nowSeconds) {
      infoExpiryText = myl10n.formatValueSync("info-already-expired");
    } else {
      let vals = {
        date: keyObj.expiry,
      };
      infoExpiryText = myl10n.formatValueSync("info-will-expire", vals);

      let remainingDays = Math.floor((keyObj.expiryTime - nowSeconds) / 86400);

      monthsMin = Math.ceil((remainingDays + 15) / 30) + 1;

      if (monthsMin > monthsMax) {
        monthsMin = monthsMax;
        monthsSel = monthsMax;
        document.getElementById("radio-expire-yes").disabled = true;
      } else if (monthsMin > 12) {
        monthsSel = monthsMin + 12;
        if (monthsSel > monthsMax) {
          monthsSel = monthsMax;
        }
      }
    }
  }

  document.getElementById("info-current-expiry").textContent = infoExpiryText;

  let popup = document.getElementById("monthsPopup");
  let selectLater = null;
  for (let i = monthsMin; i <= monthsMax; i++) {
    let item = document.createXULElement("menuitem");
    let istr = i.toString();
    item.setAttribute("value", istr);
    item.setAttribute("label", istr);
    if (i == monthsSel) {
      selectLater = item;
    }
    popup.appendChild(item);
  }
  selectLater.setAttribute("selected", "true");
  document.getElementById("expire-months").value = monthsSel.toString();
}

function enableExpiryInput() {
  let disOk = true;
  if (gRadio) {
    let dis = gRadio.value != "expire";
    document.getElementById("expire-months").disabled = dis;
    document.getElementById("expire-months-label").disabled = dis;
    disOk = gRadio.value == "keep-existing";
  }
  document.querySelector("dialog").getButton("accept").disabled = disOk;
}

/**
 * Resize the months menupopup in order to fit inside a dialog only if the
 * Change Expiry dialog wasn't opened as subDialog from the Account Settings.
 *
 * @param {DOMEvent} event - The popup showing event.
 */
function resizeMonthsPopup(event) {
  if (parent.gSubDialog) {
    return;
  }
  event.target.sizeTo(event.target.clientWidth - 16, 200);
}

async function onAccept() {
  let choice = gRadio.value;
  if (choice == "keep-existing") {
    return true;
  }

  let nowSeconds = Math.floor(Date.now() / 1000);
  let secondsSinceKeyCreation = nowSeconds - gKeyCreated;

  let newExpireSeconds = 0; // do-not-expire
  if (choice == "expire") {
    let newExpireDays = document.getElementById("expire-months").value * 30;
    newExpireSeconds = secondsSinceKeyCreation + newExpireDays * 24 * 60 * 60;
  }

  let unlockFailed = false;

  let pwCache = {
    passwords: [],
  };

  let keyTrackers = [];
  for (let fp of gFingerprints) {
    let tracker = RnpPrivateKeyUnlockTracker.constructFromFingerprint(fp);
    tracker.setAllowPromptingUserForPassword(true);
    tracker.setAllowAutoUnlockWithCachedPasswords(true);
    tracker.setPasswordCache(pwCache);
    await tracker.unlock();
    keyTrackers.push(tracker);
    if (!tracker.isUnlocked()) {
      unlockFailed = true;
      break;
    }
  }

  let rv = false;
  if (!unlockFailed) {
    rv = RNP.changeExpirationDate(gFingerprints, newExpireSeconds);
  }

  for (let t of keyTrackers) {
    t.release();
  }

  return rv;
}

document.addEventListener("dialogaccept", async function (event) {
  // Prevent the closing of the dialog to wait until the call
  // to onAccept() has properly returned.
  event.preventDefault();
  let result = await onAccept();
  // If the change was unsuccessful, leave this dialog open.
  if (!result) {
    return;
  }
  // Otherwise, update the parent window and close the dialog.
  window.arguments[0].modified();
  window.close();
});
