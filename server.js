// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io'); // Destructure Server from socket.io
const path = require('path');
const cors = require('cors');
const { ethers } = require('ethers'); // Destructure ethers
require('dotenv').config();

// Initialize Express app
const app = express();

const fs = require('fs');

// Create HTTP server
const server = http.createServer(app);


const allowedOrigins = [
  'http://localhost:4000',
  process.env.REACT_APP_SOCKET_SERVER_URL_DEV,
  process.env.REACT_APP_SOCKET_SERVER_URL_PROD
];

// Initialize Socket.io server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: allowedOrigins, // Corrected origins
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true,
}));
app.use(express.json());

// Initialize Ethers.js

// Extract environment variables
const { PRIVATE_KEY, SEPOLIA_RPC_URL, TOKEN_ADDRESS,ABI_PATH,PORT } = process.env;

// Validate Essential Environment Variables
if (!PRIVATE_KEY || !SEPOLIA_RPC_URL || !TOKEN_ADDRESS || !ABI_PATH) {
  console.error("Missing essential environment variables. Please check your .env file.");
  process.exit(1);
}
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Define token contract ABI and address
const tokenABI = JSON.parse(fs.readFileSync(process.env.ABI_PATH)).abi;
const tokenAddress = process.env.TOKEN_ADDRESS;

// Initialize token contract instance
const tokenContract = new ethers.Contract(tokenAddress, tokenABI, wallet);

// Player matchmaking variables
let waitingPlayers = [];
const rematchRequests = {};

// Helper function to determine game outcome
function determineWinner(player1Move, player2Move) {
  if (player1Move === player2Move) return 'draw';
  if (
    (player1Move === 'rock' && player2Move === 'scissors') ||
    (player1Move === 'scissors' && player2Move === 'paper') ||
    (player1Move === 'paper' && player2Move === 'rock')
  ) {
    return 'win';
  }
  return 'lose';
}

// Matchmaking function to pair players
function matchmaking(socket) {
  console.log(`Attempting to match player ${socket.id}`);

  if (waitingPlayers.length > 0) {
    const opponentId = waitingPlayers.shift();
    const opponentSocket = io.sockets.sockets.get(opponentId);

    if (opponentSocket) {
      // Pair the two players
      socket.opponent = opponentId;
      opponentSocket.opponent = socket.id;

      // Notify both players with their roles
      io.to(socket.id).emit('matchFound', { opponentId, role: 'offerer' });
      io.to(opponentId).emit('matchFound', { opponentId: socket.id, role: 'answerer' });

      console.log(`Matched ${socket.id} (offerer) with ${opponentId} (answerer)`);
    } else {
      // Opponent socket not found, retry matchmaking
      console.log(`Opponent ${opponentId} not found. Retrying matchmaking for ${socket.id}`);
      matchmaking(socket);
    }
  } else {
    // No available players, add to waiting list
    waitingPlayers.push(socket.id);
    socket.emit('waitingForOpponent');
    console.log(`Player ${socket.id} is waiting for an opponent.`);
  }
}

// Handle Socket.io connections
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.emit('welcome', 'Welcome to the Rock Paper Scissors game!');

  // Set wallet address from client
  socket.on('setWalletAddress', (walletAddress) => {
    socket.walletAddress = walletAddress;
    console.log(`Player ${socket.id} set wallet address to ${walletAddress}`);
  });

  // Player ready to play (enters matchmaking)
  socket.on('readyToPlay', () => {
    console.log(`Player ${socket.id} is ready to play.`);
    matchmaking(socket);
  });

  // Handle 'signal' event
  socket.on('signal', (data) => {
    const { to, from, signal } = data;
    console.log(`Received signal from ${from} to ${to}:`, signal);

    const recipientSocket = io.sockets.sockets.get(to);
    if (recipientSocket) {
      recipientSocket.emit('signal', { from, signal });
      console.log(`Forwarded signal from ${from} to ${to}:`, signal);
    } else {
      console.error(`Signal failed: Socket ${to} does not exist.`);
      socket.emit('opponentDisconnected', 'Your opponent is no longer available.');
    }
  });

  // Handle player move
  socket.on('playerMove', async (data) => {
    console.log(`Player ${socket.id} selected move: ${data.move}`);
    socket.move = data.move;

    if (socket.opponent) {
      const opponentSocket = io.sockets.sockets.get(socket.opponent);
      if (opponentSocket && opponentSocket.move) {
        // Both players have made their moves
        const result = determineWinner(socket.move, opponentSocket.move);
        console.log(`Game result between ${socket.id} and ${socket.opponent}: ${result}`);

        let winnerSocket = null;
        let loserSocket = null;

        if (result === 'win') {
          winnerSocket = socket;
          loserSocket = opponentSocket;
        } else if (result === 'lose') {
          winnerSocket = opponentSocket;
          loserSocket = socket;
        }

        // Emit game results
        if (result === 'draw') {
          io.to(socket.id).emit('gameResult', { result: 'Draw' });
          io.to(opponentSocket.id).emit('gameResult', { result: 'Draw' });
          console.log(`Game resulted in a draw between ${socket.id} and ${opponentSocket.id}`);
        } else {
          io.to(winnerSocket.id).emit('gameResult', { result: 'You won!' });
          io.to(loserSocket.id).emit('gameResult', { result: 'You lost!' });
          console.log(`Player ${winnerSocket.id} won against ${loserSocket.id}`);

          // Mint tokens to the winner
          try {
            console.log(`Attempting to mint tokens to ${winnerSocket.walletAddress}`);
            const tx = await tokenContract.mint(winnerSocket.walletAddress, ethers.parseUnits('5', 18));
            await tx.wait();
            console.log(`Minted 5 tokens to ${winnerSocket.walletAddress} - Transaction Hash: ${tx.hash}`);

            // Notify the winner about successful token minting
            io.to(winnerSocket.id).emit('tokensSent', {
              status: 'success',
              txHash: tx.hash,
            });
          } catch (error) {
            console.error(`Failed to mint tokens: ${error.message}`);
            io.to(winnerSocket.id).emit('tokensSent', {
              status: 'error',
              error: error.message,
            });
          }
        }

        // Reset moves
        socket.move = null;
        opponentSocket.move = null;
      } else {
        console.log(`Opponent ${socket.opponent} has not made a move yet.`);
      }
    } else {
      console.log(`Player ${socket.id} has no opponent set.`);
    }
  });

  // Endpoint to test minting functionality
  app.post('/test-mint', async (req, res) => {
    const { winnerAddress, amount } = req.body;

    if (!winnerAddress || !amount) {
      return res.status(400).send("Invalid request, must provide winnerAddress and amount.");
    }

    try {
      console.log(`Attempting to mint ${amount} tokens to ${winnerAddress}`);
      const tx = await tokenContract.mint(winnerAddress, ethers.parseUnits(amount.toString(), 18));
      await tx.wait();
      console.log(`Minted ${amount} tokens to ${winnerAddress} - Transaction Hash: ${tx.hash}`);

      return res.status(200).send({
        status: 'success',
        txHash: tx.hash
      });
    } catch (error) {
      console.error(`Failed to mint tokens: ${error.message}`);
      return res.status(500).send({
        status: 'error',
        error: error.message
      });
    }
  });

  // Handle rematch requests
  socket.on('requestRematch', () => {
    console.log(`Received 'requestRematch' from ${socket.id}`);
    
    if (socket.opponent) {
      const opponentSocket = io.sockets.sockets.get(socket.opponent);
      if (opponentSocket) {
        if (rematchRequests[opponentSocket.id]) {
          console.log(`Opponent ${opponentSocket.id} has already requested a rematch.`);
          // Opponent already requested a rematch
          io.to(socket.id).emit('rematchReady', { opponentId: opponentSocket.id });
          io.to(opponentSocket.id).emit('rematchReady', { opponentId: socket.id });
          rematchRequests[opponentSocket.id] = false;
          rematchRequests[socket.id] = false;

          // Reassign Opponents
          socket.opponent = opponentSocket.id;
          opponentSocket.opponent = socket.id;

          console.log(`Rematch agreed between ${socket.id} and ${opponentSocket.id}`);
        } else {
          // Player requests rematch, notify opponent
          rematchRequests[socket.id] = true;
          io.to(opponentSocket.id).emit('opponentWantsRematch');
          io.to(socket.id).emit('waitingForOpponentRematch');

          console.log(`Player ${socket.id} requested a rematch. Notified opponent ${opponentSocket.id}.`);
        }
      } else {
        // Opponent not found
        console.log(`Opponent ${socket.opponent} not found for player ${socket.id}.`);
        
        socket.emit('opponentLeft', 'Your opponent has disconnected.');
        socket.opponent = null;
        matchmaking(socket);
      }
    } else {
      console.log(`Player ${socket.id} has no opponent to rematch with.`);
      socket.emit('opponentLeft', 'You have no opponent to rematch with.');
    }
  });

  // Handle rematchReady event
  socket.on('rematchReady', (data) => {
    const { opponentId } = data;
    const opponentSocket = io.sockets.sockets.get(opponentId);
    if (opponentSocket) {
      // Reassign opponents
      socket.opponent = opponentId;
      opponentSocket.opponent = socket.id;

      // Notify both players with their roles
      io.to(socket.id).emit('matchFound', { opponentId, role: 'offerer' });
      io.to(opponentSocket.id).emit('matchFound', { opponentId: socket.id, role: 'answerer' });

      console.log(`Rematch agreed between ${socket.id} (offerer) and ${opponentId} (answerer)`);
    } else {
      console.log(`Opponent ${opponentId} not found for rematch.`);
      socket.emit('opponentLeft', 'Your opponent has disconnected.');
      socket.opponent = null;
      matchmaking(socket);
    }
  });

  // Handle finding a new opponent
  socket.on('findNewOpponent', () => {
    console.log(`Player ${socket.id} is searching for a new opponent.`);
    
    if (socket.opponent) {
      const opponentSocket = io.sockets.sockets.get(socket.opponent);
      if (opponentSocket) {
        console.log(`Notifying opponent ${opponentSocket.id} that player ${socket.id} is finding a new opponent.`);
        
        opponentSocket.emit('opponentLeft', 'Your opponent has decided to find a new opponent.');
        opponentSocket.opponent = null;
        delete rematchRequests[opponentSocket.id];
        matchmaking(opponentSocket);
      }
      socket.opponent = null;
    }

    delete rematchRequests[socket.id];
    matchmaking(socket);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    // Remove from waiting players if present
    waitingPlayers = waitingPlayers.filter(id => id !== socket.id);

    if (socket.opponent) {
      const opponentSocket = io.sockets.sockets.get(socket.opponent);
      if (opponentSocket) {
        console.log(`Notifying opponent ${opponentSocket.id} that player ${socket.id} has disconnected.`);
        opponentSocket.emit('opponentDisconnected', 'Your opponent has disconnected.');
        opponentSocket.opponent = null;
        delete rematchRequests[opponentSocket.id];
        matchmaking(opponentSocket);
      }
    }

    delete rematchRequests[socket.id];
  });
});

// Start the server
server.listen(PORT || 4000, () => {
  console.log(`Backend server is running on port ${PORT || 4000}`);
});
