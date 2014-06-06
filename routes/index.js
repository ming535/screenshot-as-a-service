var utils = require('../lib/utils');
var join = require('path').join;
var fs = require('fs');
var path = require('path');
var request = require('request');
var AWS = require('aws-sdk');
var s3 = new AWS.S3();
var gm = require('gm');

var DEFAULT_WIDTH = 1080;
var DEFAULT_HEIGHT = 640;

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

    ['v', 'dimentions', 'clipRect', 'javascriptEnabled', 'loadImages', 'localToRemoteUrlAccessEnabled', 'userAgent', 'userName', 'password', 'delay', 'uploadToS3', 'zoomFactor'].forEach(function(name) {
      if (req.param(name, false)) options.headers[name] = req.param(name);
    });

    if (req.param('dimentions')) {
      console.log('req.dimentions: ', req.param('dimentions'))
      options.headers['dimentions'] = JSON.parse(req.param('dimentions'))
    }

    // filename is a has of options and width and height of image
    var filename = null;

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

  var keyToS3 = function(key, width, height) {
    return key.substring(0, key.length - 4) + '_' + width + '-' + height + '.png';
  };

  var uploadImageToS3 = function(rasterizerOptions, imagePath, s3Filename, callbackUrl, errorCallback) {
    var fileBuffer = fs.readFileSync(imagePath);
    console.log('uploadImageToS3....')

    var bucket;
    if (process.env.NODE_ENV == 'production') {
      bucket = 'strikingly-production-v1';
    } else {
      bucket = 'strikingly-staging-v1';
    }

    var key = 'screenshots/' + s3Filename;

    // upload resized version
    if (rasterizerOptions.headers.dimentions) {
      rasterizerOptions.headers.dimentions.forEach(function(dimention) {
        var imageMagick = gm.subClass({ imageMagick: true });
        imageMagick(imagePath).resize(dimention.width, dimention.height)
          .stream(function(err, stdout, stderr) {
            var buf = new Buffer(0);
            stdout.on('data', function(d) {
              buf = Buffer.concat([buf, d]);
            });
            stdout.on('end', function() {
              var dimentionKey = keyToS3(key, dimention.width, dimention.height)
              var data = {
                ACL: 'public-read',
                Bucket: bucket,
                Key: dimentionKey,
                Body: buf,
                ContentType: 'image/png'
              };
              s3.client.putObject(data, function(error, res) {
                if (error) {
                  console.log('uploading ', dimentionKey, ' failed')
                  console.log(error)
                } else {
                  console.log('uploading ', dimentionKey, ' success')
                }
              });
            });
          });

      });
    }

    // upload original version to S3
    var defaultKey = keyToS3(key, DEFAULT_WIDTH, DEFAULT_HEIGHT);

    s3.putObject({
      ACL: 'public-read',
      Bucket: bucket,
      Key: defaultKey,
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
        fs.unlinkSync(imagePath);
        console.log("successfully deleted " + imagePath);
      }
    })

  }

  var postS3Url = function(rasterizerOptions, bucket, key, callbackUrl, errorCallback) {
    var url = "https://s3.amazonaws.com/" + bucket + '/' + key
    console.log('postS3Url: ', url)
    console.log('postS3Url: callbackUrl: ', callbackUrl)
    if (rasterizerOptions.headers.dimentions) {
      var dimentions = rasterizerOptions.headers.dimentions;
      dimentions.push({width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT})
      dimentions.map(function(d) {
        d.url = "https://s3.amazonaws.com/" + bucket + '/' + keyToS3(key, d.width, d.height)
      });

      postData = {
        dimentions: dimentions,
        v: rasterizerOptions.headers.v
      }
    } else {
      postData = {
        s3_url: url,
        width: 1024,
        height: 768
      }
    }
    console.log("postData: ", postData);

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