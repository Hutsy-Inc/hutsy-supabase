/**
 * Supabase Edge Function to create a Plaid Link Token.
 *
 * This function handles HTTP POST requests to generate a Plaid Link Token for a user,
 * using credentials and configuration provided via environment variables. It supports
 * CORS preflight requests and returns appropriate error messages for missing parameters
 * or Plaid API errors.
 *
 * Environment Variables:
 * - PLAID_CLIENT_ID: Plaid API client ID.
 * - PLAID_SECRET: Plaid API secret.
 * - PLAID_ENV: Plaid environment ('sandbox', 'development', or 'production').
 *
 * Request Body Parameters:
 * - email (string, required): User's email address (used as client_user_id).
 * - phone (string, optional): User's phone number.
 *
 * Responses:
 * - 200: Returns a JSON object containing the generated `link_token`.
 * - 400: Returns an error if required parameters are missing.
 * - 500: Returns an error if the Plaid API call fails or other exceptions occur.
 *
 * Example Usage:
 * See the code comments for a sample `curl` command to invoke this function locally.
 */
import "@supabase/functions-js/edge-runtime.d.ts"
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode, LinkTokenCreateRequest, DepositoryAccountSubtype, CreditAccountSubtype } from 'plaid'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}


Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID')
    const PLAID_SECRET = Deno.env.get('PLAID_SECRET')
    const PLAID_ENV = Deno.env.get('PLAID_ENV') || 'sandbox'

    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
      throw new Error('Missing Plaid credentials')
    }

    const configuration = new Configuration({
      basePath: PlaidEnvironments[PLAID_ENV],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
          'PLAID-SECRET': PLAID_SECRET,
        },
      },
    })

    const plaidClient = new PlaidApi(configuration)


    const { email, phone } = await req.json()

    if (!email) {
      return new Response(
        JSON.stringify({ error: 'email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const request: LinkTokenCreateRequest = {
      user: {
        client_user_id: email,
        ...(phone && { phone_number: phone }),
      },
      client_name: 'Hutsy Finance App',
      products: [Products.Transactions],
      transactions: {
        days_requested: 730,
      },
      country_codes: [CountryCode.Ca],
      language: 'en',
      account_filters: {
        depository: {
          account_subtypes: [DepositoryAccountSubtype.Checking, DepositoryAccountSubtype.Savings],
        },
        credit: {
          account_subtypes: [CreditAccountSubtype.CreditCard],
        },
      },
    }

    const response = await plaidClient.linkTokenCreate(request)
    const linkToken = response.data.link_token

    return new Response(
      JSON.stringify({ link_token: linkToken }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error creating Plaid link token:', error)

    const errorMessage = error instanceof Error ? error.message : 'Failed to create link token'
    const errorDetails = (error && typeof error === 'object' && 'response' in error)
      ? (error.response as { data?: unknown })?.data
      : null

    return new Response(
      JSON.stringify({
        error: errorMessage,
        details: errorDetails
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/* To invoke locally:

  1. Set environment variables in .env file:
     PLAID_CLIENT_ID=your_client_id
     PLAID_SECRET=your_secret
     PLAID_ENV=sandbox

  2. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)

  3. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/create_plaid_link' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{
      "email": "user@example.com",
      "phone": "+1 415 5550123"
    }'

*/
