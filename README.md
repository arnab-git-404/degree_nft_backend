# DegreeNFT Backend

[![Node.js](https://img.shields.io/badge/Node.js-18.x-green)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-5.0-brightgreen)](https://www.mongodb.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

This repository contains the backend server for the DegreeNFT project. It provides a RESTful API to manage the lifecycle of academic credentials, from issuance by universities to minting by students on the Solana blockchain.

## 📋 Table of Contents

* [Overview](#-overview)
* [Features](#-features)
* [Tech Stack](#-tech-stack)
* [API Endpoints](#-api-endpoints)
* [Project Structure](#-project-structure)
* [Environment Variables](#️-environment-variables)
* [Installation](#-installation)
* [Running the Server](#️-running-the-server)
* [Contributing](#-contributing)
* [License](#-license)

## 📖 Overview

The DegreeNFT backend acts as the central hub between the university-facing frontend, the student-facing frontend, and the underlying data persistence layer. Its primary role is to manage "NFT allocations" — authorizations created by a university that permit a specific student to mint their degree certificate as an NFT.

Key responsibilities:
- Securely store credential metadata URIs (from IPFS)
- Manage credential status: pending, confirmed, minted
- Handle issue reporting between students and universities

## ✨ Features

* **NFT Allocation**: Allows universities to create single or batch authorizations for students to mint their degree NFTs.
* **Authorization Check**: Enables the student dashboard to verify if the connected wallet has a pending credential to mint.
* **Credential Confirmation**: Provides an endpoint for students to confirm the accuracy of their degree details before minting.
* **Minting Confirmation**: Tracks when a student has successfully minted their NFT on-chain.
* **Credential Retrieval**: Fetches a list of already minted credentials for a student's wallet.
* **Issue Reporting**: Allows students to report discrepancies in their credential details to the issuing university.

## 🛠 Tech Stack

* [**Node.js**](https://nodejs.org/): JavaScript runtime environment
* [**Express.js**](https://expressjs.com/): Web framework for building the REST API
* [**MongoDB**](https://www.mongodb.com/): NoSQL database for storing credential data
* [**Mongoose**](https://mongoosejs.com/): Object Data Modeling (ODM) library for MongoDB
* [**CORS**](https://www.npmjs.com/package/cors): Middleware for enabling Cross-Origin Resource Sharing
* [**dotenv**](https://www.npmjs.com/package/dotenv): For managing environment variables

## 🔌 API Endpoints

Here are the main API routes provided by the server:

| Method | Endpoint | Description | 
| :----- | :----- | :----- | 
| `POST` | `/api/create-nft-ipfsHash-allocation` | Creates a new NFT allocation for a student. (University Only) | 
| `GET` | `/api/check-authorization/:walletAddress` | Checks if a student wallet is authorized to mint a credential. | 
| `POST` | `/api/confirm-nft-credential` | Allows a student to confirm their credential details are correct. | 
| `POST` | `/api/confirm-mint` | Marks a credential as minted after on-chain confirmation. | 
| `GET` | `/api/minted-nfts/:walletAddress` | Retrieves all minted NFTs associated with a student wallet. | 
| `POST` | `/api/report-issue` | Submits an issue report from a student to their university. | 

## 📁 Project Structure
```
├── controllers/      # Logic for handling API requests
├── models/           # Mongoose schemas for database models
├── routes/           # Express route definitions
├── .env.example      # Example environment variables file
├── .gitignore        # Git ignore file
├── package.json      # Project dependencies and scripts
└── server.js         # Main server entry point
```

## ⚙️ Environment Variables

To run this project, you will need to create a `.env` file in the root directory and add the following environment variables:

```env
# Server Configuration
PORT=5001

# MongoDB Connection
MONGODB_URI=your_mongodb_connection_string

# Frontend URL for CORS
CLIENT_URL=http://localhost:5173
```

## 🚀 Installation

1.  Clone the repository:
    ```sh
    git clone [https://github.com/arnab-git-404/DegreeNFT-backend.git](https://github.com/arnab-git-404/DegreeNFT-backend.git)
    cd DegreeNFT-backend
    ```

2.  Install the dependencies:
    ```sh
    npm install
    ```

3.  Create a `.env` file in the root directory and populate it with your configuration (see [Environment Variables](#️-environment-variables)).

## ▶️ Running the Server

* **Development Mode**: This will run the server with `nodemon`, which automatically restarts on file changes.
    ```sh
    npm run dev
    ```

* **Production Mode**: This will start the server in a production-ready state.
    ```sh
    npm start
    ```

The API will be available at `http://localhost:5001` (or the port you specify in your .env file).

## 🤝 Contributing

Contributions are always welcome! If you'd like to contribute, please fork the repository and create a pull request. You can also open an issue with the tag "enhancement".

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for more details.
