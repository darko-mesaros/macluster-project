import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3Deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsManager from 'aws-cdk-lib/aws-secretsmanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';

import * as path from 'path';

const CERTIFICATE_ARN = 'arn:aws:acm:us-west-2:824852318651:certificate/826bd4a1-5838-49c0-ae8e-57a983f813a8'
const DOMAIN_NAME = 'macluster.rup12.net'

export class MaclusterCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'macluster-vpc', { maxAzs: 2});
    const cluster = new ecs.Cluster(this, 'macluster-inlet', { vpc });

    var inletsToken = new secretsManager.Secret(this, 'exit-server-token', {
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true
      }
    });

    var licenseKey = secretsManager.Secret.fromSecretCompleteArn(this, 'license-key', 'arn:aws:secretsmanager:us-west-2:824852318651:secret:inlets-key-ZRkces');

    var exitServerDefinition = new ecs.FargateTaskDefinition(this, 'inlets-exit-server-task', {
      cpu: 2048,
      memoryLimitMiB: 4096,
    });

    var exitServerContainer = exitServerDefinition.addContainer('inlets', {
      image: ecs.ContainerImage.fromRegistry('ghcr.io/inlets/inlets-pro:0.9.3-rc1'),
      logging: new ecs.AwsLogDriver({ streamPrefix: 'inlets-exit-server' }),
      command: ["http","server", "--auto-tls=false","--token-env=INLETS_TOKEN", "--port=8000"],
      secrets: {
        INLETS_TOKEN: ecs.Secret.fromSecretsManager(inletsToken),
      },
      portMappings: [
        {
          containerPort: 8123,
          hostPort: 8123,
        },
        {
          containerPort: 8000,
          hostPort: 8000,
        }
      ],
    });

    exitServerContainer.addUlimits({
      softLimit: 1024000,
      hardLimit: 1024000,
      name: ecs.UlimitName.NOFILE
    });

    var service = new ecs.FargateService(this, 'inlets-exit-server', {
      cluster,
      taskDefinition: exitServerDefinition,
      assignPublicIp: true,
      healthCheckGracePeriod: Duration.seconds(2147483588),
      desiredCount: 2
    });

    service.connections.allowToAnyIpv4(ec2.Port.tcp(8123));
    service.connections.allowToAnyIpv4(ec2.Port.tcp(8000));

    const lb = new elbv2.ApplicationLoadBalancer(this, 'inlets-lb', {
      vpc,
      internetFacing: true,
    });

    var cert = acm.Certificate.fromCertificateArn(this, 'cert', CERTIFICATE_ARN);

    const inletsClientListener = lb.addListener('client-listener', {
      port: 8123,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [cert],
    });

    inletsClientListener.addTargets('inlets-private', {
      port: 8123,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [ service.loadBalancerTarget({
        containerName: 'inlets',
        containerPort: 8123,
      })],
      loadBalancingAlgorithmType: elbv2.TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS,
      healthCheck: { 
        healthyHttpCodes: '404',
      }
    });

    const inletsSecurePublicListener = lb.addListener('public-listener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [cert],
    });

    inletsSecurePublicListener.addTargets('inlets-public', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [ service.loadBalancerTarget({
        containerName: 'inlets',
        containerPort: 8000,
      })]
    });

    const inletsPublicListener = lb.addListener('redirect-listener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
      }),
    });


    var clientDefinition = new ecs.ExternalTaskDefinition(this, 'client-inlets',{
      networkMode: ecs.NetworkMode.HOST,
    });

    var clientContainer = clientDefinition.addContainer('inlets', {
      cpu: 256,
      memoryLimitMiB: 256,
      image: ecs.ContainerImage.fromRegistry('ghcr.io/inlets/inlets-pro:0.9.3-rc1'),
      logging: new ecs.AwsLogDriver({ streamPrefix: 'inlets-client' }),
      command: [
        "http", "client", `--url=wss://${DOMAIN_NAME}:8123`, "--token-env=INLETS_TOKEN", "--upstream", "localhost:80",
        "--auto-tls=false", // We don't need the automatic self signed TLS, as the ALB has a cert
        "--license-env=LICENSE_KEY"
      ],
      secrets: {
        INLETS_TOKEN: ecs.Secret.fromSecretsManager(inletsToken),
        LICENSE_KEY: ecs.Secret.fromSecretsManager(licenseKey),
      },
    });

    clientContainer.addUlimits({
      softLimit: 1024000,
      hardLimit: 1024000,
      name: ecs.UlimitName.NOFILE
    });

    var inletsDaemon = new ecs.ExternalService(this, 'inlets-tunnel', {
      cluster,
      taskDefinition: clientDefinition,
      desiredCount: 1,
    });

    //-PATCH-------------------------------------------------------------------------------------------
    // An override patch to turn the external service into a DAEMON. This
    // is only necessary because the CDK construct for ExternalService currently
    // does not support the `daemon` property. This patch can be removed in the future
    // when that CDK construct implementation gap has been fixed. :(
    const cfnDaemon = inletsDaemon.node.defaultChild as ecs.CfnService;
    cfnDaemon.schedulingStrategy = 'DAEMON';
    cfnDaemon.desiredCount = undefined;
    //--------------------------------------------------------------------------------------------------

    var appDefinition = new ecs.ExternalTaskDefinition(this, 'demo-app-definition');

    var ecrRepo = new ecr.Repository(this, 'macluster-repo');

    const demoImage = new DockerImageAsset(this, 'demo-app-image', {
      directory: path.join(__dirname, '../app'),
    });

    var image = ecs.ContainerImage.fromDockerImageAsset(demoImage);

    var appContainer = appDefinition.addContainer('app', {
      cpu: 512,
      memoryLimitMiB: 512,
      image: image,
      logging: new ecs.AwsLogDriver({ streamPrefix: 'app' }),
      command: ['node', 'index.js'],
      environment: {
        STATIC_URL: 'foo',
      },
      portMappings: [
        {
          hostPort: 80,
          containerPort: 3000,
        }
      ],
    });
    
    appContainer.addUlimits({
      softLimit: 1024000,
      hardLimit: 1024000,
      name: ecs.UlimitName.NOFILE,
    });


    new ecs.ExternalService(this, 'demo-app-service', {
      cluster,
      taskDefinition: appDefinition,
      desiredCount: 3,
    });


  }
}
