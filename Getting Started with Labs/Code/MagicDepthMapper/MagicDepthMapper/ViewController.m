//
// Copyright (c) 2015 Adobe Systems Incorporated. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
//
//
//  ViewController.m
//  MagicDepthMapper
//

#import "ViewController.h"
#import "ViewController+Buttons.h"
#import <AdobeCreativeSDKCore/AdobeUXAuthManager.h>

#warning Please update these required values to match the ones provided by creativesdk.com
static NSString * const kCreativeSDKClientId = @"Change me";
static NSString * const kCreativeSDKClientSecret = @"Change me";
static NSString * const kCreativeSDKRedirectURLString = @"Change me";

@implementation ViewController

- (void)viewDidLoad {
    
    [super viewDidLoad];
    
    // Set the client ID and secret values so the CSDK can identify the calling app. The three
    // specified scopes are required at a minimum.
    [[AdobeUXAuthManager sharedManager] setAuthenticationParametersWithClientID:kCreativeSDKClientId
                                                                   clientSecret:kCreativeSDKClientSecret
                                                            additionalScopeList:@[AdobeAuthManagerUserProfileScope,
                                                                                  AdobeAuthManagerEmailScope,
                                                                                  AdobeAuthManagerAddressScope]];
    
    // Also set the redirect URL, which is required by the CSDK authentication mechanism.
    [AdobeUXAuthManager sharedManager].redirectURL = [NSURL URLWithString:kCreativeSDKRedirectURLString];
    
    // add the buttons
    [self addButtons];
    
    // init and add the magic perspective view
    self.magicDepth = [[AdobeLabsMagicDepthMapper alloc] init];
    
    self.imageView = [[UIImageView alloc] initWithFrame:CGRectMake(0, VIEW_Y_OFFSET, self.view.bounds.size.width, self.view.bounds.size.height-VIEW_Y_OFFSET)];
    self.imageView.contentMode = UIViewContentModeScaleAspectFit;
    [self.view addSubview: self.imageView];
    self.result = nil;
}

-(void)viewDidAppear:(BOOL)animated
{
    static BOOL firstTime = YES;
    
    if (firstTime) {
        firstTime = NO;
        
        // login to creative cloud
        
        [[AdobeUXAuthManager sharedManager] login: self onSuccess: nil onError: ^(NSError * error ) {
            if ([AdobeUXAuthManager sharedManager].isAuthenticated) return;
            if (error.domain == AdobeAuthErrorDomain && error.code == AdobeAuthErrorCodeOffline) return;
            
            CGRect rect = self.view.frame; rect.origin.x += 10; rect.size.width -= 10;
            UILabel * errorLabel = [[UILabel alloc] initWithFrame: rect];
            errorLabel.text = @"Please restart app and login to Creative Cloud";
            [self.view addSubview: errorLabel];
        }];
    }
}


- (void)onButtonImage1 {
    [self loadImage: @"kid.jpg"];
}

- (void)onButtonImage2 {
    [self loadImage: @"haleakala.jpg"];
}

- (void)onButtonDepth {

    if (self.result == nil)
    {
        // compute depth map may take some time to finish processing the image so put up a spinner
        UIActivityIndicatorView * spinner;
        spinner = [self createSpinner];
        
        [self.magicDepth estimateDepthMap:self.input withCompletionBlock: ^(NSError *error) {
            [spinner removeFromSuperview];
            self.result = [self.magicDepth getDepthMap];
            self.imageView.image = self.result;
        } ];
    }
    
    
}

- (void)loadImage: (NSString *)imageName {
    self.input = [UIImage imageNamed: imageName];
    if (self.input)
    {
        self.imageView.image = self.input;
        self.result = nil;
    }
}

@end
