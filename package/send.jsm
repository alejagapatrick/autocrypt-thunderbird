/*global Components: false */
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */


"use strict";

var EXPORTED_SYMBOLS = ["AutocryptSend"];





const AutocryptLog = ChromeUtils.import("chrome://autocrypt/content/modules/log.jsm").AutocryptLog;
const AutocryptFiles = ChromeUtils.import("chrome://autocrypt/content/modules/files.jsm").AutocryptFiles;
const AutocryptStdlib = ChromeUtils.import("chrome://autocrypt/content/modules/stdlib.jsm").AutocryptStdlib;
const AutocryptFuncs = ChromeUtils.import("chrome://autocrypt/content/modules/funcs.jsm").AutocryptFuncs;
const Services = ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
const AutocryptRNG = ChromeUtils.import("chrome://autocrypt/content/modules/rng.jsm").AutocryptRNG;
const MailServices = ChromeUtils.import("resource:///modules/MailServices.jsm").MailServices;

var AutocryptSend = {
  /**
   * Send out an email
   *
   * @param msgData    - String: complete MIME string of email (including all headers etc.)
   * @param compFields - Object: compose fields (nsIMsgCompFields)
   * @param listener   - Object: progress listener (nsIMsgSendListener)
   *
   * @return Boolean - true: everything was OK to send the message
   */

  sendMessage: function(msgData, compFields, listener = null) {
    AutocryptLog.DEBUG("AutocryptSend.sendMessage()\n");
    let tmpFile, msgIdentity;
    try {
      tmpFile = AutocryptFiles.getTempDirObj();
      tmpFile.append("message.eml");
      tmpFile.createUnique(0, 0o600);
    }
    catch (ex) {
      return false;
    }

    AutocryptFiles.writeFileContents(tmpFile, msgData);
    AutocryptLog.DEBUG("AutocryptSend.sendMessage: wrote file: " + tmpFile.path + "\n");

    try {
      msgIdentity = AutocryptStdlib.getIdentityForEmail(compFields.from);
    }
    catch (ex) {
      msgIdentity = AutocryptStdlib.getDefaultIdentity();
    }

    if (!msgIdentity) {
      return false;
    }

    AutocryptLog.DEBUG("AutocryptSend.sendMessage: identity key: " + msgIdentity.identity.key + "\n");

    let acct = AutocryptFuncs.getAccountForIdentity(msgIdentity.identity);
    if (!acct) return false;

    AutocryptLog.DEBUG("AutocryptSend.sendMessage: account key: " + acct.key + "\n");

    let msgSend = Cc["@mozilla.org/messengercompose/send;1"].createInstance(Ci.nsIMsgSend);
    msgSend.sendMessageFile(msgIdentity.identity,
      acct.key,
      compFields,
      tmpFile,
      true, // Delete  File On Completion
      false, (Services.io.offline ? Ci.nsIMsgSend.nsMsgQueueForLater : Ci.nsIMsgSend.nsMsgDeliverNow),
      null,
      listener,
      null,
      ""); // password

    return true;
  },

  /**
   * Send message (simplified API)
   *
   * @param aParams: Object -
   *    - identity: Object - The identity the user picked to send the message
   *    - to:       String - The recipients. This is a comma-separated list of
   *                       valid email addresses that must be escaped already. You probably want to use
   *                       nsIMsgHeaderParser.MakeFullAddress to deal with names that contain commas.
   *    - cc (optional) Same remark.
   *    - bcc (optional) Same remark.
   *    - returnReceipt (optional) Boolean: ask for a receipt
   *    - receiptType (optional) Number: default: take from identity
   *    - requestDsn (optional) Boolean: request a Delivery Status Notification
   *    - composeSecure (optional) (contains securityInfo for TB < 64)
   *
   * @param body: complete message source
   * @param callbackFunc: function(Boolean) - return true if message was sent successfully
   *                                           false otherwise
   *
   * @return Boolean - true: everything was OK to send the message
   */
  simpleSendMessage: function(aParams, body, callbackFunc) {
    AutocryptLog.DEBUG("AutocryptSend.simpleSendMessage()\n");
    let fields = Cc["@mozilla.org/messengercompose/composefields;1"]
      .createInstance(Ci.nsIMsgCompFields);
    let identity = aParams.identity;

    fields.from = identity.email;
    fields.to = aParams.to;
    if ("cc" in aParams) fields.cc = aParams.cc;
    if ("bcc" in aParams) fields.bcc = aParams.bcc;
    fields.returnReceipt = ("returnReceipt" in aParams) ? aParams.returnReceipt : identity.requestReturnReceipt;
    fields.receiptHeaderType = ("receiptType" in aParams) ? aParams.receiptType : identity.receiptHeaderType;
    fields.DSN = ("requestDsn" in aParams) ? aParams.requestDsn : identity.requestDSN;
    if ("composeSecure" in aParams) {
      if ("securityInfo" in fields) {
        // TB < 64
        fields.securityInfo = aParams.securityInfo;
      }
      else
        fields.composeSecure = aParams.composeSecure;
    }

    fields.messageId = AutocryptRNG.generateRandomString(27) + "-enigmail";
    body = "Message-Id: " + fields.messageId + "\r\n" + body;

    let listener = {
      onStartSending: function() {},
      onProgress: function() {},
      onStatus: function() {},
      onGetDraftFolderURI: function() {},
      onStopSending: function(aMsgID, aStatus, aMsg, aReturnFile) {
        if (callbackFunc) callbackFunc(true);
      },
      onSendNotPerformed: function(aMsgID, aStatus) {
        if (callbackFunc) callbackFunc(false);
      }
    };

    return this.sendMessage(body, fields, listener);
  }
};
