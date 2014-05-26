var utils = require('../lib/utils');
var join = require('path').join;
var fs = require('fs');
var path = require('path');
var request = require('request');
var AWS = require('aws-sdk');
var s3 = new AWS.S3();

module.exports = function(app, useCors) {
  var rasterizerService = app.settings.rasterizerService;
  var fileCleanerService = app.settings.fileCleanerService;

  // routes
  app.get('/', function(req, res, next) {

    if (!req.param('url', false)) {
      return res.redirect('/usage.html');
    }

    var url = utils.url(req.param('url'));
    // required options
    var options = {
      uri: 'http://localhost:' + rasterizerService.getPort() + '/',
      headers: { url: url }
    };

    ['clipRect', 'javascriptEnabled', 'loadImages', 'localToRemoteUrlAccessEnabled', 'userAgent', 'userName', 'password', 'delay', 'uploadToS3', 'zoomFactor'].forEach(function(name) {
      if (req.param(name, false)) options.headers[name] = req.param(name);
    });

    // filename is a has of options and width and height of image
    var filename = null;
    console.log(req.param)
    if (req.param('width') || req.param('height')) {
      filename = 'screenshot_' + utils.md5(url + JSON.stringify(options)) + '-' + String(req.param('width')) + '-' + String(req.param('height')) + '.png';
    } else {
      filename = 'screenshot_' + utils.md5(url + JSON.stringify(options)) + '.png';
    }

    // fill in options of width and heigth here
    ['width', 'height'].forEach(function(name) {
      if (req.param(name, false)) options.headers[name] = req.param(name);
    })

    options.headers.filename = filename;

    var filePath = join(rasterizerService.getPath(), filename);

    console.log('filePath: ', filePath)

    var callbackUrl = req.param('callback', false) ? utils.url(req.param('callback')) : false;
    console.log('callbackUrl: ', callbackUrl)
    // dont use cache
    // if (fs.existsSync(filePath)) {
    //   console.log('Request for %s - Found in cache', url, ' filePath: ', filePath);
    //   processImageUsingCache(filePath, res, callbackUrl, function(err) { if (err) next(err); });
    //   return;
    // }

    console.log('Request for %s - Rasterizing it', url);
    console.log('Reeust options: ', options)
    var s3Filename = filename
    processImageUsingRasterizer(options, filePath, s3Filename, res, callbackUrl, function(err) { if(err) next(err); });
  });

  app.get('*', function(req, res, next) {
    // for backwards compatibility, try redirecting to the main route if the request looks like /www.google.com
    res.redirect('/?url=' + req.url.substring(1));
  });

  // bits of logic
  var processImageUsingCache = function(filePath, res, url, callback) {
    if (url) {
      // asynchronous
      res.send('Will post screenshot to ' + url + ' when processed');
      postImageToUrl(filePath, url, callback);
    } else {
      // synchronous
      sendImageInResponse(filePath, res, callback);
    }
  }

  var processImageUsingRasterizer = function(rasterizerOptions, filePath, s3Filename, res, callbackUrl, errorCallback) {
    console.log('processImageUsingRasterizer...');
    if (callbackUrl) {
      // asynchronous
      res.send('Will post screenshot to ' + callbackUrl + ' when processed');
      console.log("Will callRasterizer and return async");
      callRasterizer(rasterizerOptions, function(error) {
        if (error) return errorCallback(error);

        // if uploadToS3, then upload the image and post the S3 url to callback
        if (rasterizerOptions.headers.uploadToS3 == 'true') {
          uploadImageToS3(rasterizerOptions, filePath, s3Filename, callbackUrl, errorCallback);
        }
        else {
          postImageToUrl(filePath, callbackUrl, errorCallback);
        }
      });
    } else {
      // synchronous
      callRasterizer(rasterizerOptions, function(error) {
        if (error) return errorCallback(error);
        sendImageInResponse(filePath, res, errorCallback);
      });
    }
  }

  var callRasterizer = function(rasterizerOptions, callback) {
    request.get(rasterizerOptions, function(error, response, body) {
      if (error || response.statusCode != 200) {
        console.log('Error while requesting the rasterizer: %s', error.message);
        rasterizerService.restartService();
        return callback(new Error(body));
      }
      callback(null);
    });
  }

  var postImageToUrl = function(imagePath, url, callback) {
    console.log('Streaming image to %s', url);
    var fileStream = fs.createReadStream(imagePath);
    fileStream.on('end', function() {
      fileCleanerService.addFile(imagePath);
    });
    fileStream.on('error', function(err){
      console.log('Error while reading file: %s', err.message);
      callback(err);
    });
    fileStream.pipe(request.post(url, function(err) {
      if (err) console.log('Error while streaming screenshot: %s', err);
      callback(err);
    }));
  }

  var uploadImageToS3 = function(rasterizerOptions, imagePath, s3Filename, callbackUrl, errorCallback) {
    var fileBuffer = fs.readFileSync(imagePath);
    console.log('uploadImageToS3....')

    var bucket = 'strikingly-staging-v1';
    var key = 'screenshots/' + s3Filename;

    // upload to S3
    s3.putObject({
      ACL: 'public-read',
      Bucket: bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: 'image/png'
    }, function(error, message) {
      if (error) {
        console.log('uploading ', imagePath, ' failed')
        errorCallback(error)
      } else {
        console.log('uploading ', imagePath, ' success')
        // post to callbackUrl with S3 url
        postS3Url(rasterizerOptions, bucket, key, callbackUrl, errorCallback)
      }
    })

  }

  var postS3Url = function(rasterizerOptions, bucket, key, callbackUrl, errorCallback) {
    var url = "https://s3.amazonaws.com/" + bucket + '/' + key
    console.log('postS3Url: ', url)
    console.log('postS3Url: callbackUrl: ', callbackUrl)
    if (rasterizerOptions.headers.width || rasterizerOptions.headers.height) {
      postData = {
        s3_url: url,
        width: rasterizerOptions.headers.width,
        height: rasterizerOptions.headers.height
      }
    } else {
      postData = {
        s3_url: url
      }
    }

    request.post(callbackUrl, {
      json: postData
    }, function(err) {
      if (err) {
        console.log("Error while postS3Url to callback")
        errorCallback(err)
      }
    })
  }

  var sendImageInResponse = function(imagePath, res, callback) {
    console.log('Sending image in response');
    if (useCors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Type");
    }
    res.sendfile(imagePath, function(err) {
      fileCleanerService.addFile(imagePath);
      callback(err);
    });
  }

};