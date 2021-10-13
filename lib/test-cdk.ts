import * as ecr from '@aws-cdk/aws-ecr'
import * as ecs from '@aws-cdk/aws-ecs'
import * as events from '@aws-cdk/aws-events'
import * as targets from '@aws-cdk/aws-events-targets'
import * as iam from '@aws-cdk/aws-iam'
import * as cdk from '@aws-cdk/core'
import * as ec2 from '@aws-cdk/aws-ec2'


// const BATCH_REPOSITORY_NAME = 'mpcloud/backend/batch'
// const LAMBDA_SUBSCRIPTION_REPOSITORY_NAME =
//   'mpcloud/backend/lambda/subscription'
// const LAMBDA_EMAIL_REPOSITORY_NAME = 'mpcloud/backend/lambda/email'



export class BatchStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const accountID = cdk.Stack.of(this).account
    const region = cdk.Stack.of(this).region

    const projectKeyLower = getCdkParameter(this, 'projectKeyLower')
    const vpcID = getCdkParameter(this, 'vpcID')
    const branchName = getEnvValue(this, 'branchName')

    const prefixName = projectKeyLower + '-' + getEnvcode(this)
    const ssmParamPrefix = '/mpcloud/' + getEnvcode(this) + '/env/'
    const secretsArn = getEnvValue(this, 'envSecretsArn')

    const batchContainerID = this.node.tryGetContext('batchContainerID')
    

    // VPC 指定
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
      vpcId: vpcID,
    })
    // プライベートサブネットのIDを取得
    const privateSubnetIds: string[] = []
    for (const subnet of vpc.privateSubnets) {
      privateSubnetIds.push(subnet.subnetId)
    }

    //============================
    // Batch用のECSクラスター
    //============================
    const batchCluster = new ecs.Cluster(this, 'BatchCluster', {
      vpc,
      clusterName: prefixName + '-batch-cluster',
    })

    //============================
    // Batch のタスク定義
    //============================

    // タスク定義のARN
    // NOTE: batchTaskDefinition.taskDefinitionArn で取得できるARNはリビジョンが含まれてしまうので、リビジョンを除いたARNを定義
    const batchTaskDefinitionArn = `arn:aws:ecs:${region}:${accountID}:task-definition/${batchTaskDefinition.family}`

    //============================
    // Batch用のコンテナ
    //============================
    new events.Rule(this, 'listenBatchEcsRule', {
      ruleName: prefixName + '-events-rule-listen-batch-ecs',
      eventPattern: {
        source: ['aws.ecs'],
        detail: { clusterArn: [batchCluster.clusterArn] },
        detailType: ['ECS Task State Change'],
      },
      targets: [new targets.LambdaFunction(listenBatchEcsFunction)],
    })
    // metric filter
    const metricFilterlExitFailure =
      listenBatchEcsFunction.logGroup.addMetricFilter(
        'ListenBatchEcsMetricExitFailure',
        {
          metricNamespace: prefixName + '-listen-batch-ecs',
          metricName: 'exitFailure',
          filterPattern: {
            logPatternString: '{ $.detail.containers[0].exitCode != 0 }',
          },
        }
      )

    // image
    const batchRepository = ecr.Repository.fromRepositoryName(
      this,
      'BatchRepository',
      BATCH_REPOSITORY_NAME
    )
    const batchImage = ecs.ContainerImage.fromEcrRepository(
      batchRepository,
      branchName
    )

    // secrets manager から環境変数を取得
    // const env = secrets.Secret.fromSecretCompleteArn(
    //   this,
    //   'Secrets',
    //   getEnvValue(this, 'envSecretsArn')
    // )
    // タスク定義に基本となるコンテナを追加
    // 各スケジュールごとにタスク定義のコンテナを上書きする
    // TODO: 適切な値を検討
    batchTaskDefinition.addContainer(batchContainerID, {
      image: batchImage,
      memoryLimitMiB: 512,
      cpu: 256,
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'batch',
      }),
      command: ['/bin/mpcloud-batch'],
    })

    //==============================================
    // Batchタスク起動用のEventBridgeのRule
    // 起動バッチごとにスケジュールとターゲットタスクを作成する
    //==============================================
    // EventBridgeのIAM Role
    const eventsRole = new iam.Role(this, 'EventsRole', {
      roleName: prefixName + '-events-execution-role',
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    })

    const passRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [executionRole.roleArn, batchTaskDefinition.taskRole.roleArn],
      actions: ['iam:PassRole'],
    })
    const ecsRunTaskPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [batchTaskDefinitionArn],
      conditions: {
        ArnEquals: {
          'ecs:cluster': batchCluster.clusterArn,
        },
      },
      actions: ['ecs:RunTask'],
    })
    eventsRole.addToPolicy(passRolePolicy)
    eventsRole.addToPolicy(ecsRunTaskPolicy)

    // ScheduledTaskのSecurityGroup
    const ScheduledTaskSecurityGroup = new ec2.SecurityGroup(
      this,
      'SecurityGroup',
      {
        securityGroupName: prefixName + '-batch-sg',
        vpc,
        description: prefixName + '-batch-sg',
      }
    )

    // ===== GeneratePresignedURL Batch バッチ =====
    // TODO: dev, stgの起動時間は見直しが必要
    // [dev, stg] cron(0,6 0 ? * ? *) UTC Cron 式, 毎日 JST 9時00分, 15時00分 の実行に設定する
    const scheduleGeneratePresignedURL = cronEvents(
      this,
      'generatePresignedURL'
    )

    const generatePresignedURLRule = new events.CfnRule(
      this,
      'BatchEventsGeneratePresignedURL',
      {
        name: prefixName + '-batch-events-rule-generate-presigned-url',
        state: 'ENABLED',
        scheduleExpression: scheduleGeneratePresignedURL.expressionString,
        targets: [
          {
            roleArn: eventsRole.roleArn,
            arn: batchCluster.clusterArn,
            id: 'Target0',
            ecsParameters: {
              launchType: 'FARGATE',
              taskDefinitionArn: batchTaskDefinitionArn,
              platformVersion: 'LATEST',
              networkConfiguration: {
                awsVpcConfiguration: {
                  subnets: privateSubnetIds,
                  securityGroups: [ScheduledTaskSecurityGroup.securityGroupId],
                },
              },
              taskCount: 1,
            },
            input:
              '{"containerOverrides":[{"name":"BatchContainer","command":["/bin/mpcloud-batch", "generatePresignedURL"]}]}',
          },
        ],
      }
    )
  }
}
