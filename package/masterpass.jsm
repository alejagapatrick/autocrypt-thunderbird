/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*global Components: false */

"use strict";

var EXPORTED_SYMBOLS = ["AutocryptMasterpass"];

const AutocryptLog = ChromeUtils.import("chrome://autocrypt/content/modules/log.jsm").AutocryptLog;

const PASS_URI = 'chrome://autocrypt';
const PASS_REALM = 'DO NOT DELETE';
const PASS_USER = 'autocrypt';

var AutocryptMasterpass = {
  getLoginManager: function() {
    if (!this.loginManager) {
      try {
        this.loginManager = Components.classes["@mozilla.org/login-manager;1"].getService(Components.interfaces.nsILoginManager);
      } catch (ex) {
        AutocryptLog.writeException("masterpass.jsm", ex);
      }
    }
    return this.loginManager;
  },

  ensureAutocryptPassword: function() {
    let password = this.retrieveAutocryptPassword();
    if (password) {
      return;
    }

    try {
      let pass = this.generatePassword();

      AutocryptLog.DEBUG("masterpass.jsm: ensureAutocryptPassword()\n");
      let nsLoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
      //                 new nsLoginInfo(aHostname, aFormSubmitURL, aHttpRealm, aUsername, aPassword, aUsernameField, aPasswordField)
      let loginInfo = new nsLoginInfo(PASS_URI, null, PASS_REALM, PASS_USER, pass, '', '');

      this.getLoginManager().addLogin(loginInfo);
    } catch (ex) {
      AutocryptLog.writeException("masterpass.jsm", ex);
      throw ex;
    }
    AutocryptLog.DEBUG("masterpass.jsm: ensureAutocryptPassword(): ok\n");
  },

  generatePassword: function() {
    const random_bytes = new Uint8Array(32);
    crypto.getRandomValues(random_bytes);
    let result = "";
    for (let i = 0; i < 32; i++) {
      result += (random_bytes[i] % 16).toString(16);
    }
    return result;
  },

  retrieveAutocryptPassword: function() {
    AutocryptLog.DEBUG("masterpass.jsm: retrieveAutocryptPassword()\n");
    try {
      var logins = this.getLoginManager().findLogins(PASS_URI, null, PASS_REALM);

      for (let i = 0; i < logins.length; i++) {
        if (logins[i].username == PASS_USER) {
          AutocryptLog.DEBUG("masterpass.jsm: retrieveAutocryptPassword(): ok\n");
          return logins[i].password;
        }
      }
    } catch (ex) {
      AutocryptLog.writeException("masterpass.jsm", ex);
    }
    AutocryptLog.DEBUG("masterpass.jsm: retrieveAutocryptPassword(): not found!\n");
    return null;
  }
};
