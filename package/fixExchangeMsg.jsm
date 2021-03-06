/*global Components: false */
/*jshint -W097 */
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */


"use strict";

var EXPORTED_SYMBOLS = ["AutocryptFixExchangeMsg"];



const AutocryptTb60Compat = ChromeUtils.import("chrome://autocrypt/content/modules/tb60compat.jsm").AutocryptTb60Compat;
const AutocryptCore = ChromeUtils.import("chrome://autocrypt/content/modules/core.jsm").AutocryptCore;
const AutocryptFuncs = ChromeUtils.import("chrome://autocrypt/content/modules/funcs.jsm").AutocryptFuncs;
const AutocryptLog = ChromeUtils.import("chrome://autocrypt/content/modules/log.jsm").AutocryptLog;
const AutocryptStreams = ChromeUtils.import("chrome://autocrypt/content/modules/streams.jsm").AutocryptStreams;
const AutocryptMime = ChromeUtils.import("chrome://autocrypt/content/modules/mime.jsm").AutocryptMime;

const IOSERVICE_CONTRACTID = "@mozilla.org/network/io-service;1";

/*
 *  Fix a broken message from MS-Exchange and replace it with the original message
 *
 * @param nsIMsgDBHdr hdr          Header of the message to fix (= pointer to message)
 * @param String brokenByApp       Type of app that created the message. Currently one of
 *                                  exchange, iPGMail
 * @param String destFolderUri     optional destination Folder URI
 *
 * @return Promise; upon success, the promise returns the messageKey
 */
var AutocryptFixExchangeMsg = {
  fixExchangeMessage: function(hdr, brokenByApp, destFolderUri) {
    var self = this;
    return new Promise(
      function fixExchangeMessage_p(resolve, reject) {

        let msgUriSpec = hdr.folder.getUriForMsg(hdr);
        AutocryptLog.DEBUG("fixExchangeMsg.jsm: fixExchangeMessage: msgUriSpec: " + msgUriSpec + "\n");

        self.hdr = hdr;
        self.destFolder = hdr.folder;
        self.resolve = resolve;
        self.reject = reject;
        self.brokenByApp = brokenByApp;

        if (destFolderUri) {
          self.destFolder = AutocryptTb60Compat.getExistingFolder(destFolderUri);
        }


        let messenger = Cc["@mozilla.org/messenger;1"].createInstance(Ci.nsIMessenger);
        self.msgSvc = messenger.messageServiceFromURI(msgUriSpec);

        let p = self.getMessageBody();
        p.then(
          function resolved(fixedMsgData) {
            AutocryptLog.DEBUG("fixExchangeMsg.jsm: fixExchangeMessage: got fixedMsgData\n");
            if (self.checkMessageStructure(fixedMsgData)) {
              self.copyToTargetFolder(fixedMsgData);
            } else {
              reject();
            }
          });
        p.catch(
          function rejected(reason) {
            AutocryptLog.DEBUG("fixExchangeMsg.jsm: fixExchangeMessage: caught rejection: " + reason + "\n");
            reject();
            return;
          });
      }
    );
  },

  getMessageBody: function() {
    AutocryptLog.DEBUG("fixExchangeMsg.jsm: getMessageBody:\n");

    var self = this;

    return new Promise(
      function(resolve, reject) {
        let u = {};
        self.msgSvc.GetUrlForUri(self.hdr.folder.getUriForMsg(self.hdr), u, null);

        let op = (u.value.spec.indexOf("?") > 0 ? "&" : "?");
        let url = u.value.spec; // + op + 'part=' + part+"&header=enigmailConvert";

        AutocryptLog.DEBUG("fixExchangeMsg.jsm: getting data from URL " + url + "\n");

        let s = AutocryptStreams.newStringStreamListener(
          function analyzeData(data) {
            AutocryptLog.DEBUG("fixExchangeMsg.jsm: analyzeDecryptedData: got " + data.length + " bytes\n");

            if (AutocryptLog.getLogLevel() > 5) {
              AutocryptLog.DEBUG("*** start data ***\n'" + data + "'\n***end data***\n");
            }

            try {
              let msg = self.getRepairedMessage(data);

              if (msg) {
                resolve(msg);
              } else
                reject(2);
              return;

            } catch (ex) {
              reject(ex);
            }
          }
        );

        var ioServ = Components.classes[IOSERVICE_CONTRACTID].getService(Components.interfaces.nsIIOService);
        try {
          let channel = AutocryptStreams.createChannel(url);
          channel.asyncOpen(s, null);
        } catch (e) {
          AutocryptLog.DEBUG("fixExchangeMsg.jsm: getMessageBody: exception " + e + "\n");
        }
      }
    );
  },

  getRepairedMessage: function(data) {
    this.determineCreatorApp(data);

    let hdrEnd = data.search(/\r?\n\r?\n/);

    if (hdrEnd <= 0) {
      // cannot find end of header data
      throw 0;
    }

    let hdrLines = data.substr(0, hdrEnd).split(/\r?\n/);
    let hdrObj = this.getFixedHeaderData(hdrLines);

    if (hdrObj.headers.length === 0 || hdrObj.boundary.length === 0) {
      throw 1;
    }

    let boundary = hdrObj.boundary;
    let body;

    switch (this.brokenByApp) {
      case "exchange":
        body = this.getCorrectedExchangeBodyData(data.substr(hdrEnd + 2), boundary);
        break;
      case "iPGMail":
        body = this.getCorrectediPGMailBodyData(data.substr(hdrEnd + 2), boundary);
        break;
      default:
        AutocryptLog.ERROR("fixExchangeMsg.jsm: getRepairedMessage: unknown appType " + self.brokenByApp + "\n");
        throw 99;
    }

    if (body) {
      return hdrObj.headers + "\r\n" + body;
    } else {
      throw 2;
    }
  },

  determineCreatorApp: function(msgData) {
    // perform extra testing if iPGMail is assumed
    if (this.brokenByApp === "exchange") return;

    let msgTree = AutocryptMime.getMimeTree(msgData, false);

    try {
      let isIPGMail =
        msgTree.subParts.length === 3 &&
        msgTree.subParts[0].headers.get("content-type").type.toLowerCase() === "text/plain" &&
        msgTree.subParts[1].headers.get("content-type").type.toLowerCase() === "application/pgp-encrypted" &&
        msgTree.subParts[2].headers.get("content-type").type.toLowerCase() === "text/plain";

      if (!isIPGMail) {
        this.brokenByApp = "exchange";
      }
    } catch (x) {}
  },

  /**
   *  repair header data, such that they are working for PGP/MIME
   *
   *  @return: object: {
   *        headers:  String - all headers ready for appending to message
   *        boundary: String - MIME part boundary (incl. surrounding "" or '')
   *      }
   */
  getFixedHeaderData: function(hdrLines) {
    AutocryptLog.DEBUG("fixExchangeMsg.jsm: getFixedHeaderData: hdrLines[]:'" + hdrLines.length + "'\n");
    let r = {
      headers: "",
      boundary: ""
    };

    for (let i = 0; i < hdrLines.length; i++) {
      if (hdrLines[i].search(/^content-type:/i) >= 0) {
        // Join the rest of the content type lines together.
        // See RFC 2425, section 5.8.1
        let contentTypeLine = hdrLines[i];
        i++;
        while (i < hdrLines.length) {
          // Does the line start with a space or a tab, followed by something else?
          if (hdrLines[i].search(/^[ \t]+?/) === 0) {
            contentTypeLine += hdrLines[i];
            i++;
          } else {
            // we got the complete content-type header
            contentTypeLine = contentTypeLine.replace(/[\r\n]/g, "");
            let h = AutocryptFuncs.getHeaderData(contentTypeLine);
            r.boundary = h.boundary || "";
            break;
          }
        }
      } else {
        r.headers += hdrLines[i] + "\r\n";
      }
    }

    r.boundary = r.boundary.replace(/^(['"])(.*)(['"])/, "$2");

    r.headers += 'Content-Type: multipart/encrypted;\r\n' +
      '  protocol="application/pgp-encrypted";\r\n' +
      '  boundary="' + r.boundary + '"\r\n' +
      'X-Autocrypt-Info: Fixed broken PGP/MIME message\r\n';

    return r;
  },


  /**
   * Get corrected body for MS-Exchange messages
   */
  getCorrectedExchangeBodyData: function(bodyData, boundary) {
    AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectedExchangeBodyData: boundary='" + boundary + "'\n");
    let boundRx = new RegExp("^--" + boundary, "gm");
    let match = boundRx.exec(bodyData);

    if (match.index < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectedExchangeBodyData: did not find index of mime type to skip\n");
      return null;
    }

    let skipStart = match.index;
    // found first instance -- that's the message part to ignore
    match = boundRx.exec(bodyData);
    if (match.index <= 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectedExchangeBodyData: did not find boundary of PGP/MIME version identification\n");
      return null;
    }

    let versionIdent = match.index;

    if (bodyData.substring(skipStart, versionIdent).search(/^content-type:[ \t]*text\/(plain|html)/mi) < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectedExchangeBodyData: first MIME part is not content-type text/plain or text/html\n");
      return null;
    }

    match = boundRx.exec(bodyData);
    if (match.index < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectedExchangeBodyData: did not find boundary of PGP/MIME encrypted data\n");
      return null;
    }

    let encData = match.index;
    let mimeHdr = Cc["@mozilla.org/messenger/mimeheaders;1"].createInstance(Ci.nsIMimeHeaders);
    mimeHdr.initialize(bodyData.substring(versionIdent, encData));
    let ct = mimeHdr.extractHeader("content-type", false);

    if (!ct || ct.search(/application\/pgp-encrypted/i) < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectedExchangeBodyData: wrong content-type of version-identification\n");
      AutocryptLog.DEBUG("   ct = '" + ct + "'\n");
      return null;
    }

    mimeHdr.initialize(bodyData.substr(encData, 5000));
    ct = mimeHdr.extractHeader("content-type", false);
    if (!ct || ct.search(/application\/octet-stream/i) < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectedExchangeBodyData: wrong content-type of PGP/MIME data\n");
      AutocryptLog.DEBUG("   ct = '" + ct + "'\n");
      return null;
    }

    return bodyData.substr(versionIdent);
  },


  /**
   * Get corrected body for iPGMail messages
   */
  getCorrectediPGMailBodyData: function(bodyData, boundary) {
    AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectediPGMailBodyData: boundary='" + boundary + "'\n");
    let boundRx = new RegExp("^--" + boundary, "gm");
    let match = boundRx.exec(bodyData);

    if (match.index < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectediPGMailBodyData: did not find index of mime type to skip\n");
      return null;
    }

    let skipStart = match.index;
    // found first instance -- that's the message part to ignore
    match = boundRx.exec(bodyData);
    if (match.index <= 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectediPGMailBodyData: did not find boundary of text/plain msg part\n");
      return null;
    }

    let encData = match.index;

    match = boundRx.exec(bodyData);
    if (match.index < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectediPGMailBodyData: did not find end boundary of PGP/MIME encrypted data\n");
      return null;
    }

    let mimeHdr = Cc["@mozilla.org/messenger/mimeheaders;1"].createInstance(Ci.nsIMimeHeaders);

    mimeHdr.initialize(bodyData.substr(encData, 5000));
    let ct = mimeHdr.extractHeader("content-type", false);
    if (!ct || ct.search(/application\/pgp-encrypted/i) < 0) {
      AutocryptLog.DEBUG("fixExchangeMsg.jsm: getCorrectediPGMailBodyData: wrong content-type of PGP/MIME data\n");
      AutocryptLog.DEBUG("   ct = '" + ct + "'\n");
      return null;
    }

    return "--" + boundary + "\r\n" +
      "Content-Type: application/pgp-encrypted\r\n" +
      "Content-Description: PGP/MIME version identification\r\n\r\n" +
      "Version: 1\r\n\r\n" +
      bodyData.substring(encData, match.index).replace(/^Content-Type: +application\/pgp-encrypted/im,
        "Content-Type: application/octet-stream") +
      "--" + boundary + "--\r\n";
  },

  checkMessageStructure: function(msgData) {
    let msgTree = AutocryptMime.getMimeTree(msgData, true);

    try {

      // check message structure
      let ok =
        msgTree.headers.get("content-type").type.toLowerCase() === "multipart/encrypted" &&
        msgTree.headers.get("content-type").get("protocol").toLowerCase() === "application/pgp-encrypted" &&
        msgTree.subParts.length === 2 &&
        msgTree.subParts[0].headers.get("content-type").type.toLowerCase() === "application/pgp-encrypted" &&
        msgTree.subParts[1].headers.get("content-type").type.toLowerCase() === "application/octet-stream";


      if (ok) {
        // check for existence of PGP Armor
        let body = msgTree.subParts[1].body;
        let p0 = body.search(/^-----BEGIN PGP MESSAGE-----$/m);
        let p1 = body.search(/^-----END PGP MESSAGE-----$/m);

        ok = (p0 >= 0 && p1 > p0 + 32);
      }
      return ok;
    } catch (x) {}
    return false;
  },

  copyToTargetFolder: function(msgData) {
    var self = this;
    var tempFile = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("TmpD", Ci.nsIFile);
    tempFile.append("message.eml");
    tempFile.createUnique(0, 0o600);

    // ensure that file gets deleted on exit, if something goes wrong ...
    var extAppLauncher = Cc["@mozilla.org/mime;1"].getService(Ci.nsPIExternalAppLauncher);

    var foStream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    foStream.init(tempFile, 2, 0x200, false); // open as "write only"
    foStream.write(msgData, msgData.length);
    foStream.close();

    extAppLauncher.deleteTemporaryFileOnExit(tempFile);

    // note: nsIMsgFolder.copyFileMessage seems to have a bug on Windows, when
    // the nsIFile has been already used by foStream (because of Windows lock system?), so we
    // must initialize another nsIFile object, pointing to the temporary file
    var fileSpec = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    fileSpec.initWithPath(tempFile.path);


    var copyListener = {
      QueryInterface: function(iid) {
        if (iid.equals(Ci.nsIMsgCopyServiceListener) || iid.equals(Ci.nsISupports)) {
          return this;
        }
        throw Components.results.NS_NOINTERFACE;
      },
      msgKey: null,
      GetMessageId: function(messageId) {},
      OnProgress: function(progress, progressMax) {},
      OnStartCopy: function() {},
      SetMessageKey: function(key) {
        this.msgKey = key;
      },
      OnStopCopy: function(statusCode) {
        if (statusCode !== 0) {
          AutocryptLog.DEBUG("fixExchangeMsg.jsm: error copying message: " + statusCode + "\n");
          tempFile.remove(false);
          self.reject(3);
          return;
        }
        AutocryptLog.DEBUG("fixExchangeMsg.jsm: copy complete\n");

        AutocryptLog.DEBUG("fixExchangeMsg.jsm: deleting message key=" + self.hdr.messageKey + "\n");
        let msgArray = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
        msgArray.appendElement(self.hdr, false);

        self.hdr.folder.deleteMessages(msgArray, null, true, false, null, false);
        AutocryptLog.DEBUG("fixExchangeMsg.jsm: deleted original message\n");

        tempFile.remove(false);
        self.resolve(this.msgKey);
        return;
      }
    };

    let copySvc = Cc["@mozilla.org/messenger/messagecopyservice;1"].getService(Ci.nsIMsgCopyService);
    copySvc.CopyFileMessage(fileSpec, this.destFolder, null, false, this.hdr.flags, null, copyListener, null);

  }
};