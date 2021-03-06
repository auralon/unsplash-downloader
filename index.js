var async = require('async')
var commander = require('commander')
var cheerio = require('cheerio')
var http = require('http')
var https = require('https')
var request = require('request')
var fs = require('fs')
var exec = require('child_process').exec
var pretty = require('prettysize')
var archiver = require('archiver')
var pjson = require('./package.json')

var noConfig = false

try {
  var config = require('./config')
  
  if (!config.concurrent_downloads || !config.folder_path || !config.git_push || !config.all) {
    noConfig = true
  }
} catch (error) {
  var config = {}
  noConfig = true
}

try {
  var photos = require('./photos.json')
} catch (error) {
  var photos = []
}

if (noConfig) {
  commander
    .version(pjson.version)
    .option('-c, --concurrent_downloads <amount>', 'Amount of concurrent downloads allowed', 5)
    .option('-f, --folder_path <path>', 'Folder path of where to download the photos', 'photos')
    .option('-g, --git_push', 'Automatically commit & push to git repo in photos folder path')
    .option('-a, --all', 'Download all images on the front page rather than just the featured ones')
    .parse(process.argv)
}

var concurrent_downloads = !config.concurrent_downloads ? commander.concurrent_downloads : config.concurrent_downloads
var folder_path = !config.folder_path ? commander.folder_path : config.folder_path
var git_push = !config.git_push ? commander.git_push : config.git_push
var all = !config.all ? commander.all : config.all

if (!concurrent_downloads || !folder_path) {
  commander.help()
}

fs.mkdir(folder_path, function (error) {})

try {
  var metadata = require(folder_path + '/metadata.json')
} catch (error) {
  var metadata = []
}

var getPageCountAndDownload = function () {
  getPageCount(function (pageCount) {
    async.times(pageCount, function (page, next) {
      getImageInfo(page += 1, function (error, imageInfo) {
        next(error, imageInfo)
      })
    }, function (error, imageInfo) {
      var imagesToDownload = []
      
      imageInfo.forEach(function (imageInfoList) {
        imagesToDownload = imagesToDownload.concat(imageInfoList)
      })
      
      prepareToDownloadImages(imagesToDownload)
    })
  })
}

var root_url = all ? 'https://unsplash.com/filter?scope[featured]=0' : 'https://unsplash.com/filter?scope[featured]=1'

var getPageCount = function (callback) {
  var highestPage = 0
  request(root_url, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var $ = cheerio.load(body)
      $('.pagination a').each(function (index, element) {
        var linkText = $(this).text()
        
        if (!isNaN(parseInt(linkText)) && (parseInt(linkText) > highestPage)) {
          highestPage = parseInt(linkText)
        }
      })
      callback(highestPage)
    }
  })
}

var getImageInfo = function (page, callback) {
  var imageInfo = []
  
  request(root_url + '&page=' + page, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var $ = cheerio.load(body)
      
      $('.photo-container').each(function (index, element) {
        var url = $(this).find('.photo a').attr('href')
        var post_url = 'https://unsplash.com' + url.replace('/download', '')
        var imageMetadata = {
          'post_url': post_url,
          'image_url': 'https://unsplash.com' + url,
          'unsplash_id': url.replace('/photos/', '').replace('/download', '')
        }

        $(this).find('.epsilon a').each(function (index, element) {
          var linkText = $(this).text()
          var linkURL = $(this).attr('href')
          
          if (linkText === 'Download') {
            imageMetadata.image_url = imageMetadata.image_url ? imageMetadata.image_url : linkURL
          } else {
            imageMetadata.author_url = 'https://unsplash.com' + linkURL
            imageMetadata.author = linkText
          }
        })

        if (!imageMetadata.author) {
          var the_author = $(this).find('.epsilon p').text().split('/')[1]
          imageMetadata.author = the_author ? removeSpaces(the_author.replace('By', '')) : 'Unknown'
        }

        if (!imageMetadata.image_url || photos.indexOf(imageMetadata.image_url) > -1) {
          if (!imageMetadata.image_url) {
            console.log('Could not find image url for ' + post_url)
          }
        } else {
          imageInfo.push(imageMetadata)
        }
      })

      callback(null, imageInfo)
    } else {
      console.log('Failed getting image info %s', page)
      callback(true)
    }
  })
}

var removeSpaces = function (str) {
  return str.replace(/^\s\s*/, '').replace(/\s\s*$/, '')
}

var prepareToDownloadImages = function (imagesToDownload) {
    var highestId = photos.length

    if (!imagesToDownload.length) {
      console.log('Exiting, nothing to download!')
      process.exit(0)
      return
    }

    imagesToDownload.reverse()

    async.mapSeries(imagesToDownload, function (image, next) {
      image.id = highestId++
      next(null, image)
    }, function (error, imagesToDownloadWithId) {
      downloadImages(imagesToDownloadWithId)
    })
}

var downloadImages = function (imagesToDownload) {
  var currentPost = 0
  async.eachLimit(imagesToDownload, concurrent_downloads, function (imageToDownload, next) {
    console.log('Downloading image ' + (currentPost++ + 1) + ' of ' + imagesToDownload.length + ' (' + imageToDownload.post_url + ')')
    downloadImage(imageToDownload, function (the_metadata) {
      photos.push(the_metadata.image_url)
      metadata.push(the_metadata)
      next()
    })
  }, function (error) {
    console.log('Done!')

    metadata.sort(function (a,b) { 
      return a.id - b.id
    })

    fs.writeFile('photos.json', JSON.stringify(photos), 'utf8', function (error) {})
    fs.writeFile(folder_path + '/metadata.json', JSON.stringify(metadata, null, 4), 'utf8', function (error) {})
    
    if (config.create_zip) {
      console.log('Creating zip')
      fs.unlink(config.create_zip, function (error) {})
      var archive = archiver('zip')
      var output = fs.createWriteStream(config.create_zip)

      output.on('close', function () {
        console.log('Done creating zip, total size: %s bytes', pretty(archive.pointer()))
        doGitPush()
        if (!git_push) {
          runPostCommand()
        }
      })

      archive.on('error', function (error) {
        console.log('Error creating zip: ')
        throw error
      })

      archive.pipe(output)

      archive.bulk([
        { expand: true, cwd: folder_path, src: ['*.jpeg', 'metadata.json'] }
      ])

      archive.finalize()
    } else {
      doGitPush()
      if (!git_push) {
        runPostCommand()
      }
    }
  })
}

var downloadImage = function (the_metadata, callback) {
  request.head(the_metadata.image_url, function (err, res, body) {
    /*var original_filename = res.request.path.split('/').slice(-1)[0].split('?')[0]
    var filename = the_metadata.unsplash_id + path.extname(original_filename)*/
    var filename = String('0000' + the_metadata.id).slice(-4) + '_' + the_metadata.unsplash_id + '.jpeg'
    the_metadata.filename = filename
    var file = fs.createWriteStream(folder_path + '/' + filename)
    
    var handleDownload = function (response) {
      response.pipe(file)
      file.on('finish', function () {
        file.close(function () {
          callback(the_metadata)
        })
      })
    }

    if (res.request.uri.protocol == 'https:') {
      https.get(res.request.uri.href, handleDownload)
    } else {
      http.get(res.request.uri.href, handleDownload)
    }
  })
}

var doGitPush = function () {
  if (git_push) {
    console.log('Pushing to git!')
    exec('cd ' + folder_path + ' && git add -A . && git commit -am \'Add more images - ' + new Date().toLocaleDateString() + '\' && git push origin master', function (error, stdout, stderr) {
      console.log(stdout)
      runPostCommand()
    })
  }
}

var runPostCommand = function () {    
  if (config.post_command) {
    console.log('Executing post_command')
    exec(config.post_command, function (error, stdout, stderr) {
      console.log(stdout)
    })
  }
}

getPageCountAndDownload()