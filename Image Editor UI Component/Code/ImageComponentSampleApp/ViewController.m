//
//  ViewController.m
//  ImageComponentSampleApp
//
//  Created by Brad Bambara on 11/11/16.
//  Copyright © 2016 Adobe. All rights reserved.
//

#import "ViewController.h"

#import <AdobeCreativeSDKCore/AdobeCreativeSDKCore.h>
#import <AdobeCreativeSDKImage/AdobeCreativeSDKImage.h>

static NSString *const kAVYAdobeCreativeCloudKey = @"01ae7daa21404731b24869968ae15032";
static NSString *const kAVYAdobeCreativeCloudSecret = @"1919e48d-2040-4872-8e92-5fc2da0cbf2b";

@interface ViewController () <AdobeUXImageEditorViewControllerDelegate>

@property (strong, nonatomic) IBOutlet UIImageView *imageView;
@property (nonatomic, strong) AdobeUXImageEditorViewController *controller;

@end

@implementation ViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    
    [[AdobeUXAuthManager sharedManager] setAuthenticationParametersWithClientID:kAVYAdobeCreativeCloudKey
                                                               withClientSecret:kAVYAdobeCreativeCloudSecret];
}

- (IBAction)handleTap:(UITapGestureRecognizer *)sender {
    if ([sender state] == UIGestureRecognizerStateRecognized) {
        
        if ([self controller] != nil) {
            return;
        }
        
        UIImage *image = [UIImage imageNamed:@"exampleImage"];
        [self setController:[[AdobeUXImageEditorViewController alloc] initWithImage:image]];
        [[self controller] setDelegate:self];
        [self presentViewController:[self controller] animated:YES completion:nil];
    }
}

- (void)dismissEditor
{
    [self dismissViewControllerAnimated:YES completion:^{
        [self setController:nil];
    }];
}

#pragma mark - AdobeUXImageEditorViewControllerDelegate

- (void)photoEditor:(AdobeUXImageEditorViewController *)editor finishedWithImage:(UIImage *__nullable)image
{
    [[self imageView] setImage:image];
    [self dismissEditor];
}

- (void)photoEditorCanceled:(AdobeUXImageEditorViewController *)editor
{
    [self dismissEditor];
}

@end
