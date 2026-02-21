# openai-programmable-sip

## About the Project

This project demonstrates how to use OpenAI's SIP Connector to the Realtime API with Twilio Programmable Voice so you can perform a warm transfer from a virtual to human agent.

<img width="622" height="714" alt="image" src="https://github.com/user-attachments/assets/eded89c4-154a-4ea1-813e-c7263c33e45b" />

## Getting Started

### Prerequisites

- An upgraded Twilio account with a [Primary Business Profile](https://www.twilio.com/docs/trust-hub/trusthub-rest-api/console-create-a-primary-customer-profile) - Sign up using [this link](https://www.twilio.com/try-twilio)
- A Twilio number with Voice capabilities. See [instructions](https://help.twilio.com/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console) to purchase
- An [OpenAI API key](https://beta.openai.com/account/api-keys) on a premium plan or with available credits
- Access to the OpenAI Realtime API. Check [here](https://platform.openai.com/docs/guides/realtime) for more information
- Node.js/Typescript (I used version 22.15.0 – you can download it from [here](https://nodejs.org/es/blog/release/v22.15.0))
- A tunneling solution like Ngrok (You can download Ngrok [here](https://ngrok.com/download))

### Installation

1. Clone the repository:
    ```bash
    git clone https://github.com/mhughan-twilio/openai-programmable-sip.git
    ```
2. Navigate to the project directory:
    ```bash
    cd openai-programmable-sip
    ```
3. Install dependencies:
    ```bash
    npm install
    ```

## Usage

1. Duplicate the `example.env` file, rename it to `.env` and populate it with your OpenAI and Twilio credentials, the url for your tunneling solution like Ngrok, and the number for the human agent:
    ```
    OPENAI_API_KEY=sk-proj-
    OPENAI_WEBHOOK_SECRET=whsec
    OPENAI_PROJECT_ID=proj_

    PORT=8000
    DOMAIN=mhughan.ngrok.io

    TWILIO_ACCOUNT_SID=
    TWILIO_AUTH_TOKEN=

    HUMAN_AGENT_NUMBER=+15551112222
    ```
2. In any terminal, execute:
    ```bash
    ngrok http 8000 --url https://{DOMAIN}
    ```

3. From the project directory, start the application:
    ```bash
    npm run dev
    ```

4. Update the incoming voice url of your Twilio number to `https://{DOMAIN}}/incoming-call`.

5. Place a call to your Twilio Number.

6. Follow the logs to ensure the service is running.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request.