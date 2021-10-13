import * as cdk from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events'

export class SampleCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const bus = new events.CfnEventBus(this, 'bus-from-cdk', {
      name: 'fromCDK'
    })
    const rule = new events.CfnRule(this, 'rule-from-cdk', {
      name: 'FromCDKRule',
      description: 'trial',
      eventBusName: bus.attrName,
      eventPattern: {
        "detail-type": [
          "customer.created",
          "customer.updated"
        ],
        "source": [
          "Stripe"
        ]
      },
      state: "ENABLED",
      targets: [
        {
          id: "aaaaaa", 
          arn: "arn:aws:lambda:us-east-1:99999:function:first-function"
        }, 
        {
          id: "bbbbbb", 
          arn: "arn:aws:lambda:us-east-1:99999:function:second-function"
        }
    ]
    })
    rule.addDependsOn(bus)
  }
}
