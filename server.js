const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('url');
const { exec } = require('child_process');
const os = require('os');

// Create temp directory for chunk uploads
const TEMP_DIR = path.join(os.tmpdir(), 'file-server-chunks');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Track uploads in memory to improve performance
const uploadTracker = new Map();

// Constants for performance tuning
const HIGH_WATER_MARK = 2 * 1024 * 1024; // 2MB buffer for write streams
const WRITE_STREAM_OPTIONS = {
  highWaterMark: HIGH_WATER_MARK,
  flags: 'w'
};

// Performance settings
const LOW_WATER_MARK = 1024 * 1024; // 1MB threshold before resuming writes
const UPLOAD_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours timeout for uploads

const server = http.createServer((req, res) => {
  // Set CORS headers for cross-tab uploads
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range, X-File-Id');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const { pathname, query } = parse(req.url, true);
  
  // Root endpoint - serve index.html
  if (req.method === 'GET' && pathname === '/') {
    fs.readFile('./public/index.html', (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading HTML');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
  
  // List drives endpoint (Windows only)
  else if (req.method === 'GET' && pathname === '/list-drives') {
    if (process.platform === 'win32') {
      exec('wmic logicaldisk get name', (error, stdout) => {
        if (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: error.message }));
        }
        
        // Parse the output to get drive letters
        const drives = stdout.split('\r\r\n')
          .map(line => line.trim())
          .filter(line => /^[A-Za-z]:$/.test(line))
          .map(drive => drive + '\\');
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ drives }));
      });
    } else {
      // For non-Windows systems, just return root
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ drives: ['/'] }));
    }
  }
  
  // List folders endpoint
  else if (req.method === 'GET' && pathname === '/list-folders') {
    let currentPath = query.path || '/';
    
    // If we're at the root on Windows, redirect to the drive list
    if ((currentPath === '/' || currentPath === '\\') && process.platform === 'win32') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        path: '/', 
        folders: [],
        isRoot: true
      }));
    }
    
    try {
      currentPath = path.resolve(currentPath); // clean path
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      const folders = entries
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: currentPath, folders }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: '/', folders: [], error: err.message }));
    }
  }
  
  // New endpoint for chunk uploads
  else if (req.method === 'POST' && pathname === '/upload-chunk') {
    try {
      // Set CORS headers for chunked uploads
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range, X-File-Id');
      
      // Extract metadata from headers
      const fileName = decodeURIComponent(req.headers['x-file-name'] || '');
      const chunkIndex = parseInt(req.headers['x-chunk-index'] || '0', 10);
      const totalChunks = parseInt(req.headers['x-total-chunks'] || '1', 10);
      const fileId = req.headers['x-file-id'] || Date.now().toString();
      const targetPath = query.path || getCurrentPath();
      
      // Verify file name
      if (!fileName) {
        console.error('Missing file name');
        res.writeHead(400);
        return res.end(JSON.stringify({ success: false, error: 'Missing file name' }));
      }

      // Create upload directory if it doesn't exist
      const uploadDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      
      // Use the temp directory for chunks
      const tempDir = path.join(os.tmpdir(), 'file-server-chunks', fileId);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Temporary chunk file path
      const chunkPath = path.join(tempDir, `chunk-${chunkIndex}`);
      
      // If first chunk, initialize the upload tracker
      if (chunkIndex === 0) {
        // Create target directory if it doesn't exist
        const outputDir = path.resolve(targetPath);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const finalFilePath = path.join(outputDir, fileName);
        
        // Initialize the write stream with high performance settings
        uploadTracker.set(fileId, {
          finalPath: finalFilePath,
          receivedChunks: new Set(),
          writeStream: fs.createWriteStream(finalFilePath, { 
            highWaterMark: HIGH_WATER_MARK,
            flags: 'w',
            autoClose: false
          }),
          totalChunks: totalChunks,
          createdAt: Date.now(),
          // Set a longer timeout for uploads to allow background tab uploads
          timeout: setTimeout(() => {
            const upload = uploadTracker.get(fileId);
            if (upload && upload.writeStream) {
              upload.writeStream.end();
              console.log(`Upload timeout for ${fileId}`);
            }
            uploadTracker.delete(fileId);
          }, UPLOAD_TIMEOUT)
        });
        
        console.log(`New upload started: ${fileName} (${fileId})`);
      }
      
      // Get the upload tracker for this file
      const upload = uploadTracker.get(fileId);
      if (!upload) {
        // If the tracker is missing but we're on chunk 0, create it
        if (chunkIndex === 0) {
          // Reinitialize the tracker
          const outputDir = path.resolve(targetPath);
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          
          const finalFilePath = path.join(outputDir, fileName);
          
          // Initialize the write stream with high performance settings
          uploadTracker.set(fileId, {
            finalPath: finalFilePath,
            receivedChunks: new Set(),
            writeStream: fs.createWriteStream(finalFilePath, { 
              highWaterMark: HIGH_WATER_MARK,
              lowWaterMark: LOW_WATER_MARK,
              flags: 'w',
              autoClose: false
            }),
            totalChunks: totalChunks,
            createdAt: Date.now(),
            timeout: setTimeout(() => {
              const upload = uploadTracker.get(fileId);
              if (upload && upload.writeStream) {
                upload.writeStream.end();
              }
              uploadTracker.delete(fileId);
            }, UPLOAD_TIMEOUT)
          });
          
          console.log(`Reinitialized upload: ${fileName} (${fileId})`);
        } else {
          res.writeHead(400);
          return res.end(JSON.stringify({ 
            error: 'Upload session not found. The upload may have expired or the first chunk was not received.',
            shouldRestart: true
          }));
        }
      }
      
      // Check if this chunk was already received (handle retries)
      if (upload.receivedChunks.has(chunkIndex)) {
        res.writeHead(200);
        return res.end(JSON.stringify({ 
          success: true, 
          message: `Chunk ${chunkIndex + 1}/${totalChunks} already received`
        }));
      }
      
      // Pipe the data directly from request to file stream
      let dataBuffer = Buffer.alloc(0);
      
      // Collect all chunk data first
      req.on('data', (chunk) => {
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
      });
      
      // Track when the chunk is done
      req.on('end', async () => {
        try {
          // Write data to the file with backpressure handling
          const canContinue = upload.writeStream.write(dataBuffer);
          
          // Handle backpressure if needed
          if (!canContinue) {
            // Wait for drain event before proceeding
            await new Promise(resolve => upload.writeStream.once('drain', resolve));
          }
          
          // Clear buffer
          dataBuffer = null;
          
          // Mark this chunk as received
          upload.receivedChunks.add(chunkIndex);
          
          // Check if all chunks have been received
          if (upload.receivedChunks.size === upload.totalChunks) {
            // Close the file stream
            upload.writeStream.end(() => {
              console.log(`Upload complete: ${fileName} (${fileId})`);
            });
            
            // Clear the timeout and remove from tracker
            clearTimeout(upload.timeout);
            uploadTracker.delete(fileId);
            
            // Clean up temp directory
            try {
              removeDirectory(tempDir);
              console.log(`Cleaned up temporary directory: ${tempDir}`);
            } catch (cleanupError) {
              console.error('Error cleaning up temp files:', cleanupError);
            }
            
            // Send success response
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              message: 'File upload complete',
              filePath: upload.finalPath
            }));
          } else {
            // More chunks expected
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              message: `Chunk ${chunkIndex + 1}/${totalChunks} received`,
              received: upload.receivedChunks.size,
              fileId: fileId
            }));
          }
        } catch (error) {
          console.error('Error in chunk upload:', error);
          res.writeHead(500);
          res.end(`Server error during upload: ${error.message}`);
        }
      });
      
      // Handle errors
      req.on('error', (error) => {
        console.error(`Chunk upload error for ${fileId}, chunk ${chunkIndex}:`, error);
        res.writeHead(500);
        res.end(JSON.stringify({
          error: 'Error uploading chunk',
          details: error.message
        }));
      });
    } catch (error) {
      console.error('Error in chunk upload:', error);
      res.writeHead(500);
      res.end(`Server error during upload: ${error.message}`);
    }
  }
  
  // Traditional file upload endpoint
  else if (req.method === 'POST' && pathname === '/upload') {
    const contentType = req.headers['content-type'];
    
    if (!contentType || !contentType.includes('multipart/form-data')) {
      res.writeHead(400);
      return res.end(JSON.stringify({
        success: false,
        error: 'Invalid content type, expected multipart/form-data'
      }));
    }
    
    const boundary = contentType.split('boundary=')[1];
    let body = Buffer.alloc(0);

    req.on('data', chunk => body = Buffer.concat([body, chunk]));

    req.on('end', () => {
      try {
        const parts = body.toString().split('--' + boundary);
        let fileBuffer, fileName, destPath;
  
        parts.forEach(part => {
          if (part.includes('name="file"')) {
            const matches = part.match(/filename="(.+?)"/);
            if (matches) {
              fileName = matches[1];
              const start = part.indexOf('\r\n\r\n') + 4;
              const content = part.slice(start, part.lastIndexOf('\r\n'));
              fileBuffer = Buffer.from(content, 'binary');
            }
          }
          if (part.includes('name="targetPath"')) {
            const start = part.indexOf('\r\n\r\n') + 4;
            destPath = part.slice(start, part.lastIndexOf('\r\n')).trim();
          }
        });
  
        if (!fileBuffer || !fileName || !destPath) {
          res.writeHead(400);
          return res.end(JSON.stringify({
            success: false,
            error: 'Missing required fields'
          }));
        }
  
        // Create upload directory if it doesn't exist
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
  
        const fullPath = path.join(destPath, fileName);
        
        // Use write stream with performance optimizations
        const writeStream = fs.createWriteStream(fullPath, WRITE_STREAM_OPTIONS);
        
        writeStream.on('error', (err) => {
          console.error('Error writing file:', err);
          res.writeHead(500);
          res.end(JSON.stringify({
            success: false,
            error: 'Failed to save file: ' + err.message
          }));
        });
        
        writeStream.on('finish', () => {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            message: 'File uploaded successfully',
            filePath: fullPath
          }));
        });
        
        // Write the buffer to the stream
        writeStream.write(fileBuffer);
        writeStream.end();
      } catch (error) {
        console.error('Error processing upload:', error);
        res.writeHead(500);
        res.end(JSON.stringify({
          success: false,
          error: 'Server error: ' + error.message
        }));
      }
    });
  }
  
  // New endpoint for chunked upload that combines all chunks into final file
  else if (req.method === 'POST' && pathname === '/combine-chunks') {
    // Extract metadata from headers or query parameters
    const fileName = req.headers['x-file-name'] || '';
    const fileId = req.headers['x-file-id'] || '';
    const totalChunks = parseInt(req.headers['x-total-chunks'] || '0', 10);
    const targetPath = query.path || getCurrentPath();
    
    if (!fileName || !fileId || totalChunks === 0) {
      res.writeHead(400);
      return res.end(JSON.stringify({ 
        success: false, 
        error: 'Missing file information' 
      }));
    }
    
    // Check if all chunks exist
    const tempDir = path.join(os.tmpdir(), 'file-server-chunks', fileId);
    if (!fs.existsSync(tempDir)) {
      res.writeHead(404);
      return res.end(JSON.stringify({ 
        success: false, 
        error: 'Upload session not found' 
      }));
    }
    
    // Verify all chunks exist
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(tempDir, `chunk-${i}`);
      if (!fs.existsSync(chunkPath)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ 
          success: false, 
          error: `Missing chunk ${i}` 
        }));
      }
    }
    
    // Create output directory if it doesn't exist
    const outputDir = path.resolve(targetPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Path for final file
    const finalPath = path.join(outputDir, fileName);
    
    // Create write stream for final file
    const outputStream = fs.createWriteStream(finalPath, WRITE_STREAM_OPTIONS);
    
    // Set up error handler
    outputStream.on('error', (err) => {
      console.error('Error writing final file:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ 
        success: false, 
        error: 'Failed to write output file' 
      }));
    });
    
    // Combine all chunks
    combineChunks(tempDir, totalChunks, outputStream)
      .then(() => {
        // Clean up temp directory
        try {
          removeDirectory(tempDir);
        } catch (cleanupError) {
          console.error('Error cleaning up temp files:', cleanupError);
        }
        
        // Send success response
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          message: 'File assembled successfully',
          filePath: finalPath
        }));
      })
      .catch((error) => {
        console.error('Error combining chunks:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Failed to combine chunks' 
        }));
      });
  }
  
  // Serve static files from the public directory
  else if (req.method === 'GET') {
    let filePath = '.' + pathname;
    if (filePath === './') {
      filePath = './public/index.html';
    } else if (!filePath.startsWith('./public/')) {
      filePath = './public' + pathname;
    }
    
    const extname = path.extname(filePath);
    let contentType = 'text/html';
    
    switch (extname) {
      case '.js':
        contentType = 'text/javascript';
        break;
      case '.css':
        contentType = 'text/css';
        break;
      case '.json':
        contentType = 'application/json';
        break;
      case '.png':
        contentType = 'image/png';
        break;
      case '.jpg':
        contentType = 'image/jpg';
        break;
      case '.svg':
        contentType = 'image/svg+xml';
        break;
    }
    
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('File not found');
        } else {
          res.writeHead(500);
          res.end(`Server error: ${err.message}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      }
    });
  }
  
  // 404 Not Found for any other requests
  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Clean up upload tracker on server shutdown
process.on('SIGINT', () => {
  for (const [fileId, upload] of uploadTracker.entries()) {
    if (upload.writeStream) {
      upload.writeStream.end();
    }
    clearTimeout(upload.timeout);
  }
  uploadTracker.clear();
  process.exit(0);
});

// Periodically clean up stale uploads (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [fileId, upload] of uploadTracker.entries()) {
    // If upload is older than 24 hours and not completed
    if (now - upload.createdAt > UPLOAD_TIMEOUT) {
      console.log(`Cleaning up stale upload: ${fileId}`);
      if (upload.writeStream) {
        upload.writeStream.end();
      }
      clearTimeout(upload.timeout);
      uploadTracker.delete(fileId);
    }
  }
}, 60 * 60 * 1000);

// Helper function to get current path
function getCurrentPath() {
  return process.cwd();
}

// Helper function to recursively remove directory using only fs module
function removeDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        // Recursive case: it's a directory
        removeDirectory(curPath);
      } else {
        // Base case: it's a file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

// Combined with better stream handling for large files
function combineChunks(chunkDir, totalChunks, outputStream) {
  return new Promise((resolve, reject) => {
    let currentChunk = 0;
    
    function processNextChunk() {
      if (currentChunk >= totalChunks) {
        // All chunks processed
        outputStream.end();
        resolve();
        return;
      }
      
      const chunkPath = path.join(chunkDir, `chunk-${currentChunk}`);
      const readStream = fs.createReadStream(chunkPath, { 
        highWaterMark: HIGH_WATER_MARK 
      });
      
      // Handle errors
      readStream.on('error', (err) => {
        console.error(`Error reading chunk ${currentChunk}:`, err);
        reject(err);
      });
      
      // When chunk is fully read, move to next
      readStream.on('end', () => {
        currentChunk++;
        processNextChunk();
      });
      
      // Pipe this chunk to output stream (without ending it)
      readStream.pipe(outputStream, { end: false });
    }
    
    // Start processing chunks
    processNextChunk();
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));