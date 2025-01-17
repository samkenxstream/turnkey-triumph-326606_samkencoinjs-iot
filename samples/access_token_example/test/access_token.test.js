// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const assert = require('assert');
const {createJwt} = require('../common');
const mqtt = require('mqtt');
const {readFileSync} = require('fs');
const iot = require('@google-cloud/iot');
const path = require('path');
const {PubSub} = require('@google-cloud/pubsub');
const uuid = require('uuid');
const cp = require('child_process');
const cwd = path.join(__dirname, '..');
const execSync = cmd => cp.execSync(cmd, {encoding: 'utf-8'});
const {after, before, it} = require('mocha');

const deviceId = 'test-node-device';
const topicName = `nodejs-docs-samples-test-iot-${uuid.v4()}`;
const testTopicName = `nodejs-docs-samples-test-pubsub-iot-${uuid.v4()}`;
const registryName = `nodejs-test-registry-iot-${uuid.v4()}`;
const bucketName = `nodejs-test-bucket-iot-${uuid.v4()}`;
const region = 'us-central1';
const projectId =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const rsaPublicCert = '../resources/rsa_cert.pem'; // process.env.NODEJS_IOT_RSA_PUBLIC_CERT;
const rsaPrivateKey = '../resources/rsa_private.pem'; //process.env.NODEJS_IOT_RSA_PRIVATE_KEY;
const iotClient = new iot.v1.DeviceManagerClient();
const pubSubClient = new PubSub({projectId});

const cmd = 'node access_token.js';

before(async () => {
  assert(
    process.env.GCLOUD_PROJECT,
    'Must set GCLOUD_PROJECT environment variable!'
  );
  assert(
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    'Must set GOOGLE_APPLICATION_CREDENTIALS environment variable!'
  );
  // Create a Pub/Sub topic to be used for testing
  const [topic] = await pubSubClient.createTopic(topicName);
  console.log(`Topic ${topic.name} created.`);

  // Creates a registry to be used for tests.
  const createRegistryRequest = {
    parent: iotClient.locationPath(projectId, region),
    deviceRegistry: {
      id: registryName,
      eventNotificationConfigs: [
        {
          pubsubTopicName: topic.name,
        },
      ],
    },
  };

  await iotClient.createDeviceRegistry(createRegistryRequest);

  console.log(`Created registry: ${registryName}`);
  async function createDevice() {
    // Construct request
    const regPath = iotClient.registryPath(projectId, region, registryName);
    const device = {
      id: deviceId,
      credentials: [
        {
          publicKey: {
            format: 'RSA_X509_PEM',
            key: readFileSync(rsaPublicCert).toString(),
          },
        },
      ],
    };

    const request = {
      parent: regPath,
      device,
    };

    const [response] = await iotClient.createDevice(request);
    console.log('Created device', response);
  }

  await createDevice();
  console.log(`Created Device: ${deviceId}`);
});

after(async () => {
  // Delete Pub/Sub topic
  await pubSubClient.topic(topicName).delete();
  console.log(`Topic ${topicName} deleted.`);
  const devPath = iotClient.devicePath(
    projectId,
    region,
    registryName,
    deviceId
  );

  await iotClient.deleteDevice({name: devPath});

  console.log(`Device ${deviceId} deleted.`);

  const registryPath = iotClient.registryPath(projectId, region, registryName);
  await iotClient.deleteDeviceRegistry({
    name: registryPath,
  });
  console.log('Deleted test registry.');
});

it('Generate device access token, use access token to create pubsub topic, push message to pubsub topic', async () => {
  await execSync(
    `${cmd} publishPubSubMessage  ${registryName} ${deviceId} RS256 ${rsaPrivateKey} ${testTopicName}`,
    cwd
  );
});

it('Generate device access token, use access token to create GCS bucket, upload a file to bucket, download file from bucket', async () => {
  const dataPath = '../resources/logo.png';
  await execSync(
    `${cmd} downloadCloudStorageFile  ${registryName} ${deviceId} RS256 ${rsaPrivateKey} ${bucketName} ${dataPath}`,
    cwd
  );
});

it('Generate device access token, exchange device access token for service account access token, use service account access token to send cloud iot device command', async () => {
  const serviceAccountEmail =
    'cloud-iot-test@long-door-651.iam.gserviceaccount.com';
  const commandTobeSentToDevice = 'OPEN_DOOR';
  // Create device MQTT client and connect to cloud iot mqtt bridge.
  const mqttBridgeHostname = 'mqtt.googleapis.com';
  const mqttBridgePort = 8883;
  const mqttTlsCert = '../resources/roots.pem';

  // The mqttClientId is a unique string that identifies this device. For Google
  // Cloud IoT Core, it must be in the format below.
  const mqttClientId = `projects/${projectId}/locations/${region}/registries/${registryName}/devices/${deviceId}`;

  // With Google Cloud IoT Core, the username field is ignored, however it must be
  // non-empty. The password field is used to transmit a JWT to authorize the
  // device. The "mqtts" protocol causes the library to connect using SSL, which
  // is required for Cloud IoT Core.
  const connectionArgs = {
    host: mqttBridgeHostname,
    port: mqttBridgePort,
    clientId: mqttClientId,
    username: 'unused',
    password: createJwt(projectId, rsaPrivateKey, 'RS256'),
    protocol: 'mqtts',
    secureProtocol: 'TLSv1_2_method',
    ca: [readFileSync(mqttTlsCert)],
  };
  const client = mqtt.connect(connectionArgs);
  // Subscribe to the /devices/{device-id}/config topic to receive config updates.
  client.subscribe(`/devices/${deviceId}/config`, {qos: 1});
  // Subscribe to the /devices/{device-id}/commands/# topic to receive all
  // commands.
  client.subscribe(`/devices/${deviceId}/commands/#`, {qos: 0});
  client.on('connect', () => {
    console.log('Device Connected Successfully.');
  });
  client.on('message', (topic, message) => {
    if (topic.startsWith(`/devices/${deviceId}/commands`)) {
      assert.strictEqual(
        Buffer.from(message, 'base64').toString('ascii'),
        commandTobeSentToDevice
      );
    }
  });

  // Send command to device
  await execSync(
    `${cmd} sendCommandToIoTDevice  ${registryName} ${deviceId} RS256 ${rsaPrivateKey} ${serviceAccountEmail} ${commandTobeSentToDevice}`,
    cwd
  );
  // Disconnect mqtt client.
  client.end();
});
