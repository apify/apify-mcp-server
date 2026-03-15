// x402 payment middleware - add before your protected routes
import { createPaymentMiddleware } from 'x402-express'; // or implement manually

// Option A: use the x402-express package
app.use('/api', createPaymentMiddleware({
  walletAddress: process.env.X402_WALLET_ADDRESS,
  network: 'eip155:8453', // Base mainnet
  facilitatorUrl: 'https://facilitator.402.bot/verify',
}));

// Option B: manual (just check the payment header)
app.use('/api', (req, res, next) => {
  const payment = req.headers['x-payment'];
  if (!payment) {
    // Return 402 with payment requirements
    res.status(402).json({
      accepts: [{ network: 'eip155:8453', asset: 'USDC', address: process.env.X402_WALLET_ADDRESS }],
      price: '0.01',
    });
    return;
  }
  // Verify payment with facilitator
  // See: https://api.402.bot/mcp/setup
  next();
});
