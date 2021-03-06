/*global Components: false */
/*jshint -W097 */
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

"use strict";

var EXPORTED_SYMBOLS = ["AutocryptStreams"];

const AutocryptTb60Compat = ChromeUtils.import("chrome://autocrypt/content/modules/tb60compat.jsm").AutocryptTb60Compat;
const AutocryptLog = ChromeUtils.import("chrome://autocrypt/content/modules/log.jsm").AutocryptLog;
const AutocryptTimer = ChromeUtils.import("chrome://autocrypt/content/modules/timer.jsm").AutocryptTimer;
const Services = ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
const NetUtil = ChromeUtils.import("resource://gre/modules/NetUtil.jsm").NetUtil;

const NS_STRING_INPUT_STREAM_CONTRACTID = "@mozilla.org/io/string-input-stream;1";
const NS_INPUT_STREAM_CHNL_CONTRACTID = "@mozilla.org/network/input-stream-channel;1";
const IOSERVICE_CONTRACTID = "@mozilla.org/network/io-service;1";

var AutocryptStreams = {

  /** Read data from a url, used for attachments */
  getDataFromUrl: function(url) {
    AutocryptLog.DEBUG("autocrypt.jsm: getSetupMessageData()\n");

    return new Promise((resolve, reject) => {
      let s = this.newStringStreamListener(data => {
        resolve(data);
      });

      let channel = this.createChannel(url);
      channel.asyncOpen(s, null);
    });
  },

  /**
   * Create a new channel from a URL or URI.
   *
   * @param url: String, nsIURI or nsIFile -  URL specification
   *
   * @return: channel
   */
  createChannel: function(url) {
    let c = NetUtil.newChannel({
      uri: url,
      loadUsingSystemPrincipal: true
    });

    return c;
  },


  /**
   * create an nsIStreamListener object to read String data from an nsIInputStream
   *
   * @onStopCallback: Function - function(data) that is called when the stream has stopped
   *                             string data is passed as |data|
   *
   * @return: the nsIStreamListener to pass to the stream
   */
  newStringStreamListener: function(onStopCallback) {
    AutocryptLog.DEBUG("enigmailCommon.jsm: newStreamListener\n");

    let listener = {
      data: "",
      inStream: Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream),
      _onStopCallback: onStopCallback,
      QueryInterface: AutocryptTb60Compat.generateQI([Ci.nsIStreamListener, Ci.nsIRequestObserver]),

      onStartRequest: function(channel) {
        // AutocryptLog.DEBUG("enigmailCommon.jsm: stringListener.onStartRequest\n");
      },

      onStopRequest: function(channel, status) {
        // AutocryptLog.DEBUG("enigmailCommon.jsm: stringListener.onStopRequest: "+ctxt+"\n");
        this.inStream = null;
        var cbFunc = this._onStopCallback;
        var cbData = this.data;

        AutocryptTimer.setTimeout(function _cb() {
          cbFunc(cbData);
        });
      }
    };

    if (AutocryptTb60Compat.isMessageUriInPgpMime()) {
      // TB >= 67
      listener.onDataAvailable = function(req, stream, offset, count) {
        // AutocryptLog.DEBUG("enigmailCommon.jsm: stringListener.onDataAvailable: "+count+"\n");
        this.inStream.setInputStream(stream);
        this.data += this.inStream.readBytes(count);
      };
    } else {
      listener.onDataAvailable = function(req, ctxt, stream, offset, count) {
        // AutocryptLog.DEBUG("enigmailCommon.jsm: stringListener.onDataAvailable: "+count+"\n");
        this.inStream.setInputStream(stream);
        this.data += this.inStream.readBytes(count);
      };
    }

    return listener;
  },

  /**
   * create a nsIInputStream object that is fed with string data
   *
   * @uri:            nsIURI - object representing the URI that will deliver the data
   * @contentType:    String - the content type as specified in nsIChannel
   * @contentCharset: String - the character set; automatically determined if null
   * @data:           String - the data to feed to the stream
   * @loadInfo        nsILoadInfo - loadInfo (optional)
   *
   * @return nsIChannel object
   */
  newStringChannel: function(uri, contentType, contentCharset, data, loadInfo) {
    AutocryptLog.DEBUG("enigmailCommon.jsm: newStringChannel\n");

    if (!loadInfo) {
      loadInfo = createLoadInfo();
    }

    const inputStream = Cc[NS_STRING_INPUT_STREAM_CONTRACTID].createInstance(Ci.nsIStringInputStream);
    inputStream.setData(data, -1);

    if (!contentCharset || contentCharset.length === 0) {
      const ioServ = Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService);
      const netUtil = ioServ.QueryInterface(Ci.nsINetUtil);
      const newCharset = {};
      const hadCharset = {};
      let mimeType;
      mimeType = netUtil.parseResponseContentType(contentType, newCharset, hadCharset);
      contentCharset = newCharset.value;
    }

    let isc = Cc[NS_INPUT_STREAM_CHNL_CONTRACTID].createInstance(Ci.nsIInputStreamChannel);
    isc.QueryInterface(Ci.nsIChannel);
    isc.setURI(uri);
    isc.loadInfo = loadInfo;
    isc.contentStream = inputStream;

    if (contentType && contentType.length) isc.contentType = contentType;
    if (contentCharset && contentCharset.length) isc.contentCharset = contentCharset;

    AutocryptLog.DEBUG("enigmailCommon.jsm: newStringChannel - done\n");

    return isc;
  },

  newFileChannel: function(uri, file, contentType, deleteOnClose) {
    AutocryptLog.DEBUG("enigmailCommon.jsm: newFileChannel for '" + file.path + "'\n");

    let inputStream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    let behaviorFlags = Ci.nsIFileInputStream.CLOSE_ON_EOF;
    if (deleteOnClose) {
      behaviorFlags |= Ci.nsIFileInputStream.DELETE_ON_CLOSE;
    }
    const ioFlags = 0x01; // readonly
    const perm = 0;
    inputStream.init(file, ioFlags, perm, behaviorFlags);

    let isc = Cc[NS_INPUT_STREAM_CHNL_CONTRACTID].createInstance(Ci.nsIInputStreamChannel);
    isc.QueryInterface(Ci.nsIChannel);
    isc.contentDisposition = Ci.nsIChannel.DISPOSITION_ATTACHMENT;
    isc.loadInfo = createLoadInfo();
    isc.setURI(uri);
    isc.contentStream = inputStream;

    if (contentType && contentType.length) isc.contentType = contentType;

    AutocryptLog.DEBUG("enigmailCommon.jsm: newStringChannel - done\n");

    return isc;
  }
};

function createLoadInfo() {
  let c = NetUtil.newChannel({
    uri: "chrome://autocrypt/content/",
    loadUsingSystemPrincipal: true
  });

  return c.loadInfo;
}
