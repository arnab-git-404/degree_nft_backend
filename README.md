DegreeNFT BackendThis repository contains the backend server for the DegreeNFT project. It provides a RESTful API to manage the lifecycle of academic credentials, from issuance by universities to minting by students on the Solana blockchain.📋 Table of ContentsOverviewFeaturesTech StackAPI EndpointsProject StructureEnvironment VariablesInstallationRunning the ServerContributingLicense📖 OverviewThe DegreeNFT backend acts as the central hub between the university-facing frontend, the student-facing frontend, and the underlying data persistence layer. Its primary role is to manage "NFT allocations" — authorizations created by a university that permit a specific student to mint their degree certificate as an NFT.This server handles the secure storage of credential metadata URIs (from IPFS) and manages the status of each credential (e.g., pending, confirmed, minted).✨ FeaturesNFT Allocation: Allows universities to create single or batch authorizations for students to mint their degree NFTs.Authorization Check: Enables the student dashboard to verify if the connected wallet has a pending credential to mint.Credential Confirmation: Provides an endpoint for students to confirm the accuracy of their degree details before minting.Minting Confirmation: Tracks when a student has successfully minted their NFT on-chain.Credential Retrieval: Fetches a list of already minted credentials for a student's wallet.Issue Reporting: Allows students to report discrepancies in their credential details to the issuing university.🛠 Tech StackNode.js: JavaScript runtime environmentExpress.js: Web framework for building the REST APIMongoDB: NoSQL database for storing credential dataMongoose: Object Data Modeling (ODM) library for MongoDBCORS: Middleware for enabling Cross-Origin Resource Sharingdotenv: For managing environment variables🔌 API EndpointsHere are the main API routes provided by the server:MethodEndpointDescriptionPOST/api/create-nft-ipfsHash-allocationCreates a new NFT allocation for a student. (University Only)GET/api/check-authorization/:walletAddressChecks if a student wallet is authorized to mint a credential.POST/api/confirm-nft-credentialAllows a student to confirm their credential details are correct.POST/api/confirm-mintMarks a credential as minted after on-chain confirmation.GET/api/minted-nfts/:walletAddressRetrieves all minted NFTs associated with a student wallet.POST/api/report-issueSubmits an issue report from a student to their university.📁 Project Structure.
├── controllers/      # Logic for handling API requests
├── models/           # Mongoose schemas for database models
├── routes/           # Express route definitions
├── .env.example      # Example environment variables file
├── .gitignore        # Git ignore file
├── package.json      # Project dependencies and scripts
└── server.js         # Main server entry point
⚙️ Environment VariablesTo run this project, you will need to create a .env file in the root directory and add the following environment variables:# Server Configuration
PORT=5001

# MongoDB Connection
MONGODB_URI=your_mongodb_connection_string

# Frontend URL for CORS
CLIENT_URL=http://localhost:5173
🚀 InstallationClone the repository:git clone [https://github.com/arnab-git-404/DegreeNFT-backend.git](https://github.com/arnab-git-404/DegreeNFT-backend.git)
cd DegreeNFT-backend
Install the dependencies:npm install
Create a .env file in the root directory and populate it with your configuration (see Environment Variables).▶️ Running the ServerDevelopment Mode: This will run the server with nodemon, which automatically restarts on file changes.npm run dev
Production Mode: This will start the server in a production-ready state.npm start
The API will be available at http://localhost:5001 (or the port you specify in your .env file).🤝 ContributingContributions are always welcome! If you'd like to contribute, please fork the repository and create a pull request. You can also open an issue with the tag "enhancement".📄 LicenseThis project is licensed under the MIT License. See the LICENSE file for more details.
